/**
 * CLI command: nomos contacts
 *
 * Manage the unified contacts identity graph.
 *
 * Usage:
 *   nomos contacts list [--platform slack|imessage|gmail|...]
 *   nomos contacts show <id>
 *   nomos contacts link <contact-id> <platform> <user-id>
 *   nomos contacts unlink <identity-id>
 *   nomos contacts merge <id1> <id2>
 */

import { Command } from "commander";
import chalk from "chalk";
import { getDb } from "../db/client.ts";
import { listContacts, getContact, mergeContacts, searchContacts } from "../identity/contacts.ts";
import { linkIdentity, unlinkIdentity, listIdentities } from "../identity/identities.ts";
import { runAutoLinker } from "../identity/auto-linker.ts";

export function registerContactsCommand(program: Command): void {
  const contacts = program
    .command("contacts")
    .description("Manage unified contacts and identity graph");

  // nomos contacts list
  contacts
    .command("list")
    .description("List all contacts")
    .option("--platform <platform>", "Filter by platform")
    .option("--search <query>", "Search contacts by name")
    .action(async (opts) => {
      getDb();
      const results = opts.search
        ? await searchContacts(opts.search)
        : await listContacts(opts.platform);

      if (results.length === 0) {
        console.log(chalk.dim("No contacts found."));
        return;
      }

      console.log(chalk.bold(`\nContacts (${results.length})\n`));
      for (const c of results) {
        const role = c.role ? chalk.dim(` [${c.role}]`) : "";
        const autonomy = chalk.dim(` (${c.autonomy})`);
        console.log(`  ${chalk.bold(c.display_name)}${role}${autonomy}`);
        console.log(`    ${chalk.dim("ID:")} ${c.id}`);

        const identities = await listIdentities(c.id);
        for (const id of identities) {
          console.log(
            `    ${chalk.blue(id.platform)}: ${id.platform_user_id}${id.display_name ? ` (${id.display_name})` : ""}`,
          );
        }
        console.log();
      }
    });

  // nomos contacts show
  contacts
    .command("show <id>")
    .description("Show contact details")
    .action(async (id: string) => {
      getDb();
      const contact = await getContact(id);
      if (!contact) {
        console.log(chalk.red("Contact not found."));
        return;
      }

      console.log(chalk.bold(`\n${contact.display_name}\n`));
      console.log(`  ${chalk.dim("ID:")} ${contact.id}`);
      console.log(`  ${chalk.dim("Role:")} ${contact.role ?? "—"}`);
      console.log(`  ${chalk.dim("Autonomy:")} ${contact.autonomy}`);
      console.log(`  ${chalk.dim("Consent:")} ${contact.data_consent}`);
      if (contact.notes) console.log(`  ${chalk.dim("Notes:")} ${contact.notes}`);

      const identities = await listIdentities(contact.id);
      if (identities.length > 0) {
        console.log(`\n  ${chalk.bold("Linked Identities:")}`);
        for (const id of identities) {
          console.log(
            `    ${chalk.blue(id.platform)}: ${id.platform_user_id}${id.email ? ` <${id.email}>` : ""}`,
          );
        }
      }

      if (Object.keys(contact.relationship).length > 0) {
        console.log(`\n  ${chalk.bold("Relationship:")}`);
        for (const [key, value] of Object.entries(contact.relationship)) {
          console.log(`    ${chalk.dim(key)}: ${value}`);
        }
      }
    });

  // nomos contacts link
  contacts
    .command("link <contact-id> <platform> <user-id>")
    .description("Link a platform identity to a contact")
    .action(async (contactId: string, platform: string, userId: string) => {
      getDb();
      const contact = await getContact(contactId);
      if (!contact) {
        console.log(chalk.red("Contact not found."));
        return;
      }

      const identity = await linkIdentity(contactId, platform, userId);
      console.log(
        chalk.green(`Linked ${platform}:${userId} to "${contact.display_name}" (${identity.id})`),
      );
    });

  // nomos contacts unlink
  contacts
    .command("unlink <identity-id>")
    .description("Unlink a platform identity")
    .action(async (identityId: string) => {
      getDb();
      const removed = await unlinkIdentity(identityId);
      if (removed) {
        console.log(chalk.green("Identity unlinked."));
      } else {
        console.log(chalk.red("Identity not found."));
      }
    });

  // nomos contacts merge
  contacts
    .command("merge <keep-id> <merge-id>")
    .description("Merge two contacts (keeps first, merges second into it)")
    .action(async (keepId: string, mergeId: string) => {
      getDb();
      const result = await mergeContacts(keepId, mergeId);
      if (result) {
        console.log(chalk.green(`Merged into "${result.display_name}" (${result.id})`));
      } else {
        console.log(chalk.red("Contact not found."));
      }
    });

  // nomos contacts auto-link
  contacts
    .command("auto-link")
    .description("Run heuristic auto-linking to find and merge duplicate contacts")
    .action(async () => {
      getDb();
      console.log(chalk.blue("Running auto-linker..."));
      const result = await runAutoLinker();
      console.log(
        chalk.green(
          `Done. ${result.merged} auto-merged, ${result.candidates} candidates for manual review.`,
        ),
      );
    });
}
