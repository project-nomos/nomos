import type { Command } from "commander";
import chalk from "chalk";
import { loadInstalledPlugins } from "../plugins/loader.ts";
import {
  listAvailablePlugins,
  installPlugin,
  removePlugin,
  getPluginInfo,
} from "../plugins/installer.ts";

export function registerPluginCommand(program: Command): void {
  const cmd = program.command("plugin").description("Manage Nomos plugins");

  cmd
    .command("list")
    .description("List installed plugins")
    .action(async () => {
      const plugins = await loadInstalledPlugins();
      if (plugins.length === 0) {
        console.log(chalk.dim("No plugins installed. Run `nomos plugin available` to browse."));
        return;
      }
      console.log(chalk.bold(`Installed plugins (${plugins.length}):\n`));
      for (const p of plugins) {
        console.log(`  ${chalk.cyan(p.name)}  ${chalk.dim(p.description)}`);
        console.log(`    ${chalk.dim(`from ${p.marketplace} → ${p.path}`)}`);
      }
    });

  cmd
    .command("available")
    .description("Browse available plugins from the marketplace")
    .action(async () => {
      const plugins = await listAvailablePlugins();
      if (plugins.length === 0) {
        console.log(
          chalk.dim(
            "No marketplaces found. Make sure Claude Code is installed and has synced its marketplace.",
          ),
        );
        return;
      }
      console.log(chalk.bold(`Available plugins (${plugins.length}):\n`));
      for (const p of plugins) {
        const status = p.installed ? chalk.green("✓ installed") : chalk.dim("not installed");
        const sourceLabel = p.source === "external_plugins" ? chalk.yellow(" [community]") : "";
        console.log(`  ${chalk.cyan(p.name)}${sourceLabel}  ${status}`);
        console.log(`    ${chalk.dim(p.description)}`);
      }
    });

  cmd
    .command("install <name>")
    .description("Install a plugin from the marketplace")
    .option("--marketplace <name>", "Specific marketplace to install from")
    .action(async (name: string, options: { marketplace?: string }) => {
      try {
        const entry = await installPlugin(name, options.marketplace);
        console.log(chalk.green(`✓ Installed ${chalk.bold(entry.name)} from ${entry.marketplace}`));
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  cmd
    .command("remove <name>")
    .description("Remove an installed plugin")
    .action(async (name: string) => {
      await removePlugin(name);
      console.log(chalk.green(`✓ Removed ${chalk.bold(name)}`));
    });

  cmd
    .command("info <name>")
    .description("Show details about a plugin")
    .action(async (name: string) => {
      const info = await getPluginInfo(name);
      if (!info) {
        console.log(chalk.dim(`Plugin "${name}" not found in any marketplace.`));
        return;
      }
      console.log(chalk.bold(info.name));
      console.log(`  Description: ${info.description}`);
      if (info.author) console.log(`  Author:      ${info.author}`);
      console.log(`  Source:       ${info.marketplace}/${info.source}`);
      console.log(
        `  Status:       ${info.installed ? chalk.green("installed") : chalk.dim("not installed")}`,
      );
    });
}
