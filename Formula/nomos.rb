class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/releases/download/v0.1.39/nomos-0.1.39-homebrew.tar.gz"
  sha256 "ad1b08ca3dfcba16b1639617fc4a3e34ba2bc611fc990788202ec50999edf9ca"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node@22"

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
    # Pathname#write is monkey-patched by Homebrew to refuse overwriting, so
    # delete any existing plist before writing the new one (upgrades hit this).
    plist_path.delete if plist_path.exist?
    plist_path.write(plist_content)

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
    null_out = [:out, :err] => "/dev/null"

    # 1. Forcibly kill the existing daemon (matches by label, not file path).
    system "launchctl", "kill", "TERM", "#{domain}/#{label}", null_out
    sleep 1
    system "launchctl", "kill", "KILL", "#{domain}/#{label}", null_out

    # 2. Unload the old plist (file path) if still loaded.
    system "launchctl", "bootout", domain, plist_path.to_s, null_out
    # Also try unloading by label in case the file path differs.
    system "launchctl", "bootout", "#{domain}/#{label}", null_out

    # 3. Load the new plist.
    system "launchctl", "bootstrap", domain, plist_path.to_s, null_out

    # 4. Force-restart so the daemon spawns fresh from the new plist's paths.
    system "launchctl", "kickstart", "-k", "#{domain}/#{label}"
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
