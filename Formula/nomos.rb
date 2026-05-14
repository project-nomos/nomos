class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/releases/download/v0.1.32/nomos-0.1.32-homebrew.tar.gz"
  sha256 "52569bae6fd4f3e35432e020b092040a14e12eba76a33b28c56dccc420ca2622"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node@22"

  # Native Node.js addons (.node files) must not be relinked by Homebrew
  skip_clean "libexec"

  # Homebrew-managed launchd service (brew services start/stop/restart nomos)
  service do
    run [opt_bin/"nomos", "daemon", "run"]
    keep_alive true
    log_path var/"log/nomos/daemon.log"
    error_log_path var/"log/nomos/daemon.log"
    working_dir Dir.home
    environment_variables(
      HOME: Dir.home,
      PATH: "#{HOMEBREW_PREFIX}/opt/node@22/bin:#{HOMEBREW_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin",
      DAEMON_WITH_SETTINGS: "true",
      SETTINGS_PORT: "3456",
    )
    process_type :background
  end

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

    # Auto-start the service so the Settings UI is immediately accessible
    # for first-run configuration (database, API keys, integrations).
    # Falls through silently if already running or brew services unavailable.
    system "brew", "services", "restart", "nomos"
  end

  def caveats
    <<~EOS
      Nomos is now running in the background. Open the Settings UI to finish setup:

        http://localhost:3456

      The Settings UI walks you through configuring:
        - PostgreSQL database (with pgvector extension)
        - API provider (Anthropic API key, OpenRouter, Vertex AI, or Claude Max subscription)
        - Channel integrations (Slack, Discord, iMessage, etc.)
        - Personality and skills

      Service management:
        brew services restart nomos    # restart after config changes
        brew services stop nomos       # stop the daemon
        brew services info nomos       # check service status

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
