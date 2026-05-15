class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/releases/download/v0.1.45/nomos-0.1.45-homebrew.tar.gz"
  sha256 "4b3fe4179f1c7b467cb3086160a453a09a7ec0fa9e1d64190bc5a2482e489a8f"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node@22"
  depends_on macos: :sonoma # for bundled imsg binary (read/watch/send iMessage)

  # iMessage integration CLI. We bundle the pre-built binary directly from
  # openclaw's releases instead of `depends_on "steipete/tap/imsg"` because
  # cross-tap deps don't reliably auto-tap on `brew install`, which forced
  # a manual `brew tap steipete/tap` step. Resource keeps it one command.
  resource "imsg" do
    url "https://github.com/openclaw/imsg/releases/download/v0.8.2/imsg-macos.zip"
    sha256 "d0d749934599ed2568a656c1d7f26d9ebc7b63aaada20c224277479b9c5b8bf8"
  end

  # Native Node.js addons (.node files) must not be relinked by Homebrew
  skip_clean "libexec"

  # Note: no `service do` block -- post_install writes a user LaunchAgent
  # directly so the service starts immediately after install without needing
  # `brew services start`. Manage via `nomos service install/uninstall/status`.

  def install
    # The release tarball is pre-built by CI: it already contains
    # `dist/`, `node_modules/`, `skills/`, `proto/`, and a built `settings/`
    # Next.js app. No pnpm install or build steps needed at user-install time.
    # This avoids requiring GitHub Packages auth for the cate-sdk dependency.

    # Install everything except node_modules to libexec.
    libexec.install "dist"
    libexec.install "skills"
    libexec.install "proto"
    libexec.install "package.json"
    libexec.install "settings"

    # Archive node_modules as a tarball to hide native .node dylibs
    # from Homebrew's fix_dynamic_linkage phase, which fails on files
    # like ripgrep.node (insufficient Mach-O header padding for the
    # long /opt/homebrew/... dylib ID rewrite). Extracted in post_install.
    system "tar", "cf", prefix/".node_modules.tar", "node_modules"

    # Create wrapper script
    (bin/"nomos").write_env_script libexec/"dist/index.js",
      PATH: "#{Formula["node@22"].opt_bin}:$PATH"

    # Install the bundled imsg binary + helper dylib + bundles to libexec
    # and expose `imsg` on PATH. Mirrors steipete/homebrew-tap's formula
    # so behavior matches `brew install steipete/tap/imsg`.
    resource("imsg").stage do
      (libexec/"imsg-cli").install "imsg"
      (libexec/"imsg-cli").install "imsg-bridge-helper.dylib" if File.exist?("imsg-bridge-helper.dylib")
      Dir["*.bundle"].each do |bundle|
        (libexec/"imsg-cli").install bundle
      end
    end
    bin.write_exec_script libexec/"imsg-cli/imsg"
  end

  def post_install
    # Extract node_modules after Homebrew's relocation phase
    staging = prefix/".node_modules.tar"
    if staging.exist?
      cd libexec do
        system "tar", "xf", staging
      end
      staging.delete
    end

    # Don't pre-create ~/.nomos/* here: brew's post_install sandbox denies
    # mkdir under arbitrary HOME paths. The daemon creates them on startup,
    # and launchd auto-creates parent dirs for the plist's log redirection.

    # Auto-install + start a user LaunchAgent so the Settings UI is immediately
    # accessible. We can't use `brew services` from within post_install (it
    # deadlocks on brew's own lockfile), so write the plist directly.
    plist_dir = Pathname.new("#{Dir.home}/Library/LaunchAgents")
    plist_dir.mkpath
    plist_path = plist_dir/"com.projectnomos.daemon.plist"
    plist_content = <<~PLIST
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>com.projectnomos.daemon</string>
        <key>ProgramArguments</key>
        <array>
          <string>#{opt_bin}/nomos</string>
          <string>daemon</string>
          <string>run</string>
        </array>
        <key>EnvironmentVariables</key>
        <dict>
          <key>HOME</key>
          <string>#{Dir.home}</string>
          <key>PATH</key>
          <string>#{Formula["node@22"].opt_bin}:#{HOMEBREW_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin</string>
          <key>DAEMON_WITH_SETTINGS</key>
          <string>true</string>
          <key>SETTINGS_PORT</key>
          <string>3456</string>
        </dict>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <true/>
        <key>StandardOutPath</key>
        <string>#{Dir.home}/.nomos/logs/daemon.log</string>
        <key>StandardErrorPath</key>
        <string>#{Dir.home}/.nomos/logs/daemon.log</string>
        <key>WorkingDirectory</key>
        <string>#{Dir.home}</string>
        <key>ProcessType</key>
        <string>Background</string>
      </dict>
      </plist>
    PLIST
    # Only write the plist on first install. On upgrades, brew's sandbox
    # denies file-write-data and unlink on ~/Library/LaunchAgents, so we
    # can't touch the file. That's fine: ProgramArguments points to
    # `#{opt_bin}/nomos` (an opt symlink Homebrew updates automatically),
    # so the existing plist still points at the new version after upgrade.
    # The launchctl restart below is what actually swaps the running binary.
    plist_path.write(plist_content) unless plist_path.exist?

    # Restart the daemon so it picks up the new binary.
    #
    # The plist's ProgramArguments points at #{opt_bin}/nomos -- an opt
    # symlink Homebrew updates atomically to the current Cellar. The
    # plist itself never needs to change between versions.
    #
    # Brew's post_install sandbox blocks `launchctl bootstrap` on the
    # GUI session, so we can't bootout/bootstrap from here. Instead we
    # just kill the running daemon; launchd's KeepAlive=true respawns
    # it from the (now updated) opt symlink. This works on both fresh
    # installs (after we bootstrap once below) and upgrades.
    uid = Process.uid
    label = "com.projectnomos.daemon"
    domain = "gui/#{uid}"

    # Ensure the agent is loaded. On fresh install bootstrap succeeds;
    # on upgrade it errors "service already loaded" which we ignore.
    quiet_system "launchctl", "bootstrap", domain, plist_path.to_s

    # Kill the running daemon (if any) so KeepAlive respawns it from
    # the updated opt_bin symlink. quiet_system tolerates "not found".
    quiet_system "launchctl", "kill", "KILL", "#{domain}/#{label}"
  end

  def caveats
    <<~EOS
      Nomos is now running in the background. Open the Settings UI to finish setup:

        http://localhost:3456

      The Settings UI walks you through configuring:
        - PostgreSQL database (default: postgresql://localhost:5432/nomos)
          Requires the pgvector extension: brew install pgvector
        - API provider (Anthropic key, OpenRouter, Vertex AI, or Claude Max subscription)
        - Channel integrations (Slack, Discord, iMessage, etc.)
        - Personality and skills

      iMessage integration uses the bundled `imsg` CLI. To enable iMessage,
      grant Full Disk Access + Automation permission to your terminal:
        System Settings > Privacy & Security > Full Disk Access
        System Settings > Privacy & Security > Automation

      Service management:
        nomos service status         # show daemon + service state
        nomos service install        # (re)install the user LaunchAgent
        nomos service uninstall      # stop + disable auto-start on login

      CLI shortcuts:
        nomos status        # quick health check (daemon, DB, service)
        nomos chat          # interactive REPL (also runs first-time setup wizard)

      Optional — browser automation for skills:
        npx playwright install chromium
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/nomos --version")
  end
end
