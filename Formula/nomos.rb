class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/releases/download/v0.1.60/nomos-0.1.60-homebrew.tar.gz"
  sha256 "f5c80e27d3483392976ff9de7f33bd65bae56db6a6c318f38e2fa11baa626376"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node@22"
  depends_on macos: :sonoma # for bundled imsg binary (read/watch/send iMessage)

  # iMessage integration CLI. We bundle the pre-built binary directly from
  # openclaw's releases instead of `depends_on "steipete/tap/imsg"` because
  # cross-tap deps don't reliably auto-tap on `brew install`, which forced
  # a manual `brew tap steipete/tap` step. Resource keeps it one command.
  resource "imsg" do
    url "https://github.com/openclaw/imsg/releases/download/v0.8.2/imsg-macos.zip"
    sha256 "d0d749934599ed2568a656c1d7f26d9ebc7b63aaada20c224277479b9c5b8bf8"
  end

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

    # Install the bundled imsg binary + helper dylib + bundles, and expose
    # `imsg` on PATH. Mirrors steipete/homebrew-tap so behavior matches
    # `brew install steipete/tap/imsg`.
    imsg_dir = libexec/"imsg"
    imsg_dir.mkpath
    resource("imsg").stage do
      staged = Pathname.pwd
      cp staged/"imsg", imsg_dir/"imsg"
      chmod 0755, imsg_dir/"imsg"
      helper = staged/"imsg-bridge-helper.dylib"
      cp helper, imsg_dir/"imsg-bridge-helper.dylib" if helper.exist?
      Dir[staged/"*.bundle"].each { |bundle| cp_r bundle, imsg_dir }
    end
    bin.write_exec_script imsg_dir/"imsg"
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

    # Don't pre-create ~/.nomos/* here: brew's post_install sandbox denies
    # mkdir under arbitrary HOME paths. The daemon creates them on startup,
    # and launchd auto-creates parent dirs for the plist's log redirection.

    # We intentionally do NOT write the LaunchAgent plist here. Brew's
    # post_install sandbox denies file writes to ~/Library/LaunchAgents,
    # so the user installs the service themselves with `nomos service
    # install`. On upgrades, the existing plist already points at
    # #{opt_bin}/nomos -- an opt symlink Homebrew refreshes -- so we
    # restart the running daemon to load the new binary. `kickstart -k`
    # atomically kills + restarts the loaded service (a quiet no-op if it
    # was never `nomos service install`-ed), which is more deterministic
    # than a KILL signal that relies on KeepAlive to respawn.
    uid = Process.uid
    label = "com.projectnomos.daemon"
    domain = "gui/#{uid}"
    quiet_system "launchctl", "kickstart", "-k", "#{domain}/#{label}"
  end

  def caveats
    <<~EOS
      To start Nomos, run:

        nomos service install

      This installs a user LaunchAgent (~/Library/LaunchAgents) and starts
      the daemon. Then open the Settings UI to finish setup:

        http://localhost:3456

      The Settings UI walks you through configuring:
        - PostgreSQL database (default: postgresql://localhost:5432/nomos)
          Requires the pgvector extension: brew install pgvector
        - API provider (Anthropic key, OpenRouter, Vertex AI, or Claude Max subscription)
        - Channel integrations (Slack, Discord, iMessage, etc.)
        - Personality and skills

      iMessage integration uses the bundled `imsg` CLI. To enable iMessage,
      grant Full Disk Access + Automation permission to your terminal:
        System Settings > Privacy & Security > Full Disk Access
        System Settings > Privacy & Security > Automation

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
