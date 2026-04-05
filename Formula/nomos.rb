class Nomos < Formula
  require "language/node"

  desc "TypeScript CLI AI agent powered by Anthropic models"
  homepage "https://github.com/project-nomos/nomos"
  url "https://github.com/project-nomos/nomos/archive/refs/tags/vv0.1.21.tar.gz"
  sha256 "2d5030e190f633ef87789236e21678e95551a8e9bf281c65ecdc65f041f3fa20"
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

    # Install and start the launchd service directly from Ruby to avoid
    # sandbox EPERM when Node.js tries to write to ~/Library/LaunchAgents.
    # Stop any existing daemon first so ports are free for the new version.
    Kernel.system(bin/"nomos", "daemon", "stop")

    plist_label = "com.projectnomos.daemon"
    plist_dir = "#{Dir.home}/Library/LaunchAgents"
    plist_path = "#{plist_dir}/#{plist_label}.plist"
    node_bin = Formula["node@22"].opt_bin

    # Unload existing service if present
    Kernel.system("launchctl", "bootout", "gui/#{Process.uid}", plist_path) if File.exist?(plist_path)

    # Write plist from Ruby (has write access that Node sandbox lacks)
    mkdir_p plist_dir
    File.write(plist_path, <<~XML)
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>#{plist_label}</string>

        <key>ProgramArguments</key>
        <array>
          <string>#{bin/"nomos"}</string>
          <string>daemon</string>
          <string>run</string>
        </array>

        <key>EnvironmentVariables</key>
        <dict>
          <key>HOME</key>
          <string>#{Dir.home}</string>
          <key>PATH</key>
          <string>#{node_bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
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
        <string>#{nomos_dir}/logs/daemon.log</string>

        <key>StandardErrorPath</key>
        <string>#{nomos_dir}/logs/daemon.log</string>

        <key>WorkingDirectory</key>
        <string>#{Dir.home}</string>

        <key>ProcessType</key>
        <string>Background</string>
      </dict>
      </plist>
    XML

    # Load and start the service
    Kernel.system("launchctl", "bootstrap", "gui/#{Process.uid}", plist_path)
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
