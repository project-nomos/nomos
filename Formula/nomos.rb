class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/archive/refs/tags/v0.1.30.tar.gz"
  sha256 "3b8dc93ff34b8169d1f669e9d068ed70759afd4baa1b5534952155957622a6c2"
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
  end

  def caveats
    <<~EOS
      nomos requires PostgreSQL with pgvector extension.
      Configure via environment variables or the Settings UI:

        export DATABASE_URL=postgresql://user:pass@localhost:5432/nomos
        export ANTHROPIC_API_KEY=sk-ant-...

      Start the background service (daemon + Settings UI) once:
        brew services start nomos

      Future upgrades auto-restart the service.

      Check status:
        nomos status

      Run first-time setup:
        nomos chat

      Optional — browser automation:
        npx playwright install chromium
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/nomos --version")
  end
end
