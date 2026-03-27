class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/archive/refs/tags/vv0.1.4.tar.gz"
  sha256 "65c96468e78223b1b0919db1d1b0e57169f389ff22f1669436c46bb1bc4575df"
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
    # Install production dependencies only, skip postinstall (playwright/uvx)
    system "pnpm", "install", "--prod", "--ignore-scripts"

    # Fetch Anthropic skills, install build tooling, and build
    system "bash", "scripts/fetch-anthropic-skills.sh"
    system "pnpm", "install", "--ignore-scripts"
    system "pnpm", "build"

    # Install built artifacts to libexec
    libexec.install "dist"
    libexec.install "skills"
    libexec.install "proto"
    libexec.install "node_modules"
    libexec.install "package.json"

    # Fix native .node addon dylib IDs to prevent Homebrew relocation failures.
    # Some .node files (like ripgrep.node from @anthropic-ai/claude-agent-sdk)
    # are Mach-O dylibs with long build-path IDs. Homebrew's fix_dynamic_linkage
    # tries to rewrite these to /opt/homebrew/... paths that exceed the Mach-O
    # header space. Setting a short @loader_path ID prevents this.
    Dir.glob("#{libexec}/node_modules/**/*.node").each do |node_addon|
      next unless File.file?(node_addon)
      begin
        macho = MachO.open(node_addon)
        next unless macho.dylib?
        MachO::Tools.change_dylib_id(node_addon, "@loader_path/#{File.basename(node_addon)}")
        MachO.codesign!(node_addon) if Hardware::CPU.arm?
      rescue MachO::MachOError
        nil
      end
    end

    # Create wrapper script
    (bin/"nomos").write_env_script libexec/"dist/index.js",
      PATH: "#{Formula["node@22"].opt_bin}:$PATH"
  end

  def caveats
    <<~EOS
      nomos requires PostgreSQL with pgvector extension.
      Configure via environment variables or the Settings UI:

        export DATABASE_URL=postgresql://user:pass@localhost:5432/nomos
        export ANTHROPIC_API_KEY=sk-ant-...

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
