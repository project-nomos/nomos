class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/archive/refs/tags/vv0.1.24.tar.gz"
  sha256 "916c12624d936d0523aa2a0095ee2c204f392064a864fffedce02f44ef07990b"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node@22"
  depends_on "pnpm" => :build

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
    # Set package.json version from formula version (source tarball has 0.1.0)
    system "npm", "pkg", "set", "version=#{version}"

    # Install production dependencies only, skip postinstall (playwright/uvx)
    system "pnpm", "install", "--prod", "--ignore-scripts"

    # Fetch Anthropic skills, install build tooling, and build
    system "bash", "scripts/fetch-anthropic-skills.sh"
    system "pnpm", "install", "--ignore-scripts"
    system "pnpm", "build"

    # Build Settings UI (Next.js app)
    cd "settings" do
      system "pnpm", "install", "--ignore-scripts"
      system "npx", "next", "build"
    end

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

    # Ensure ~/.nomos directories exist (post_install sandbox may block mkdir from Node)
    mkdir_p "#{Dir.home}/.nomos"
    mkdir_p "#{Dir.home}/.nomos/logs"

    # Stop any manually-started daemon so brew services can take over
    Kernel.system(bin/"nomos", "daemon", "stop")

    # Remove any legacy custom plist (from pre-service-block versions)
    legacy = "#{Dir.home}/Library/LaunchAgents/com.projectnomos.daemon.plist"
    if File.exist?(legacy)
      Kernel.system("launchctl", "bootout", "gui/#{Process.uid}", legacy)
      File.delete(legacy) rescue nil
    end

    # Restart via brew services (handles launchd outside sandbox)
    Kernel.system("brew", "services", "restart", name)
  end

  def caveats
    <<~EOS
      nomos requires PostgreSQL with pgvector extension.
      Configure via environment variables or the Settings UI:

        export DATABASE_URL=postgresql://user:pass@localhost:5432/nomos
        export ANTHROPIC_API_KEY=sk-ant-...

      The background service (daemon + Settings UI) starts automatically.
      Manage it with:
        brew services start nomos
        brew services stop nomos
        brew services restart nomos

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
