class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/releases/download/v0.1.33/nomos-0.1.33-homebrew.tar.gz"
  sha256 "3832ff534a559f05e82cbc8af1428a5809d0ac06e0bf7077ef8cf05ace1b8c06"
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
    plist_path.write(plist_content)

    # Bootstrap the LaunchAgent. Ignore errors -- on upgrades the service
    # might already be loaded; users can fix manually via `nomos service install`.
    uid = Process.uid
    system "launchctl", "bootout", "gui/#{uid}", plist_path.to_s, [:out, :err] => "/dev/null"
    system "launchctl", "bootstrap", "gui/#{uid}", plist_path.to_s
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
