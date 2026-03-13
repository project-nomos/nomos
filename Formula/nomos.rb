class Nomos < Formula
  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/meidad/nomos"
  url "https://registry.npmjs.org/nomos/-/nomos-0.1.0.tgz"
  sha256 "REPLACE_WITH_SHA256"
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/nomos --version")
  end
end
