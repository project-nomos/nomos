class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_WITH_SHA256"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node@22"
  depends_on "pnpm" => :build

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
