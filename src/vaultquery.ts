import type { App } from "obsidian";
import { isVaultQueryEnabled, waitForVaultQueryAPI, type IVaultQueryAPI } from "vaultquery/api";

export async function readyVaultQuery(app: App): Promise<IVaultQueryAPI> {
  const api = await waitForVaultQueryAPI(app);

  if (!api) throw new Error(isVaultQueryEnabled(app) ? "VaultQuery has not finished starting. Reopen this note in a moment." : "The query setting requires the VaultQuery plugin to be installed and enabled.");
  await api.waitForIndexing();

  return api;
}
