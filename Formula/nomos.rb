class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/releases/download/v0.1.44/nomos-0.1.44-homebrew.tar.gz"
  sha256 "2815930d4715eb46cf4b9967281f8c112a851a268abe3fd6cdde214e8a79d73b"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node@22"
  # iMessage integration CLI -- read/watch/send via chat.db + AppleScript.
  # Auto-taps steipete/tap. Optional at runtime (the imessage adapter only
  # starts when the user enables it in Settings), but bundling here makes
  # `brew install nomos` a one-step install for the common case.
  depends_on "steipete/tap/imsg"

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

    # Ensure directories exist
    mkdir_p "#{Dir.home}/.nomos"
    mkdir_p "#{Dir.home}/.nomos/logs"
    mkdir_p var/"log/nomos"

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

    # (Re)load the LaunchAgent and force-restart it.
    # Upgrades are tricky: the old plist's ProgramArguments points at a path
    # in the old Cellar (e.g. /opt/homebrew/Cellar/nomos/0.1.37/...) which gets
    # deleted by `brew cleanup`. The old daemon process keeps running against
    # files that no longer exist, so the Settings UI fails with "ENOENT" until
    # the user manually restarts.
    #
    # Sequence:
    # 1. Kill any process from the old plist (by label, in case its file is gone)
    # 2. Bootout the old plist file path (if still loaded)
    # 3. Bootstrap the new plist
    # 4. Kickstart -k to force a fresh process from the new plist
    uid = Process.uid
    label = "com.projectnomos.daemon"
    domain = "gui/#{uid}"

    # Use quiet_system: Homebrew's Formula#system raises on non-zero exit,
    # and these launchctl commands routinely exit non-zero (killing a dead
    # process, booting out an unloaded plist, etc.). quiet_system swallows
    # both the exit code and the output, so the chain always runs to step 4.

    # 1. Forcibly kill the existing daemon (matches by label, not file path).
    quiet_system "launchctl", "kill", "TERM", "#{domain}/#{label}"
    sleep 1
    quiet_system "launchctl", "kill", "KILL", "#{domain}/#{label}"

    # 2. Unload the old plist (file path) if still loaded.
    quiet_system "launchctl", "bootout", domain, plist_path.to_s
    # Also try unloading by label in case the file path differs.
    quiet_system "launchctl", "bootout", "#{domain}/#{label}"

    # 3. Load the new plist.
    quiet_system "launchctl", "bootstrap", domain, plist_path.to_s

    # 4. Force-restart so the daemon spawns fresh from the new plist's paths.
    quiet_system "launchctl", "kickstart", "-k", "#{domain}/#{label}"
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

      iMessage integration uses `imsg` (auto-installed as a dependency).
      If `brew upgrade` reports a missing tap for `steipete/tap/imsg`, run:
        brew tap steipete/tap
      ...then retry the upgrade.

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
