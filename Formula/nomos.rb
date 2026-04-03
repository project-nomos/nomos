class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/archive/refs/tags/vv0.1.20.tar.gz"
  sha256 "2af8917c18d7d71526e1d8ef3f552829dd1dd18c20cc7e09f46f27d56c501c04"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node@22"
  depends_on "pnpm" => :build

  # Native Node.js addons (.node files) must not be relinked by Homebrew
  skip_clean "libexec"

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
    nomos_dir = "#{Dir.home}/.nomos"
    mkdir_p nomos_dir
    mkdir_p "#{nomos_dir}/logs"

    # Install and start the launchd service (handles both fresh install and upgrades)
    # Uses Kernel.system (not Formula#system) to avoid failing the install if
    # launchctl is blocked by sandbox or the daemon can't start yet
    Kernel.system(bin/"nomos", "service", "install")
  end

  def caveats
    <<~EOS
      nomos requires PostgreSQL with pgvector extension.
      Configure via environment variables or the Settings UI:

        export DATABASE_URL=postgresql://user:pass@localhost:5432/nomos
        export ANTHROPIC_API_KEY=sk-ant-...

      The daemon and Settings UI start automatically after install.
      Check status with:
        nomos status

      Manage the background service:
        nomos service install     # Re-install / restart
        nomos service uninstall   # Stop and remove

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
