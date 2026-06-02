import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Boot phase — everything before the DI container wiring.
 * Extracted from index.ts so main() focuses on wire → execute.
 */

/**
 * Curated model-catalog overlay served from our GitHub repo. Deep-merged on
 * top of models.dev so we can add/fix providers/models without an upstream
 * fix or a release. See `packages/cli/data/README.md`.
 */
const GITHUB_PROVIDERS_OVERLAY_URL =
  'https://raw.githubusercontent.com/WrongStack/WrongStack/main/packages/cli/data/providers.json';

/**
 * Resolve the bundled overlay `providers.json`. It ships at `<pkg>/data/` —
 * a sibling of both `src/` (dev) and `dist/` (published) — so `../data/…`
 * relative to this module resolves in both. Returns undefined if anything
 * about the resolution looks off (the overlay is optional).
 */
function resolveBundledOverlayFile(): string | undefined {
  try {
    return fileURLToPath(new URL('../data/providers.json', import.meta.url));
  } catch {
    return undefined;
  }
}

/** Read the bundled overlay JSON synchronously, or undefined if unavailable. */
function readBundledOverlay(): ModelsDevPayload | undefined {
  const file = resolveBundledOverlayFile();
  if (!file) return undefined;
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as ModelsDevPayload;
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
import {
  type Config,
  DefaultLogger,
  DefaultModelsRegistry,
  type ModelsDevPayload,
  type ModelsRegistry,
  type SecretVault,
  ToolRegistry,
  type WstackPaths,
  TOKENS,
} from '@wrongstack/core';
import { builtinToolsPack } from '@wrongstack/tools';
import { parseArgs } from './arg-parser.js';
import { LaunchAbortedError, runLaunchPrompts } from './pre-launch.js';
import { bootConfig } from './boot-config.js';
import { ReadlineInputReader } from './input-reader.js';
import { runPicker, saveToGlobalConfig } from './picker.js';
import { printLaunchHints } from './launch-hints.js';
import { runProjectCheck } from './pre-launch.js';
import { TerminalRenderer } from './renderer.js';
import { subcommands } from './subcommands/index.js';
import { patchConfig } from './utils.js';
import { createDefaultContainer } from '@wrongstack/runtime';
import { checkForUpdate, type UpdateInfo } from './update-check.js';

export interface BootContext {
  config: Config;
  vault: SecretVault;
  wpaths: WstackPaths;
  cwd: string;
  projectRoot: string;
  userHome: string;
  flags: Record<string, string | boolean>;
  positional: string[];
  modelsRegistry: ModelsRegistry;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  logger: DefaultLogger;
  /** Set by background update check — if outdated, index.ts shows notification */
  updateInfo?: UpdateInfo;
}

function resolveBundledSkillsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = req.resolve('@wrongstack/core/package.json');
    return path.join(path.dirname(corePkg), 'skills');
  } catch {
    return undefined;
  }
}

/**
 * Boot the CLI: parse args, load config, handle subcommand dispatch
 * (early exit), run interactive prompts (project check, provider picker,
 * mode/yolo). Returns a BootContext for the wiring phase, or an exit
 * code when the run should stop here.
 */
export async function boot(argv: string[]): Promise<BootContext | number> {
  const { flags, positional } = parseArgs(argv);

  // `wstack resume <id>` is sugar for `wstack --resume <id>`.
  if (positional[0] === 'resume' && positional[1] && !subcommands['__noop_resume_marker']) {
    flags['resume'] = positional[1];
    positional.splice(0, 2);
  }

  // `--help` / `--version` are conventional flags. Route the bare forms to the
  // `help` / `version` subcommands so they behave the same as `wstack help` /
  // `wstack version` instead of falling through to the launch path. Only when
  // no subcommand was given (so `wstack init --help` still runs `init`).
  if (positional.length === 0) {
    if (flags['help'] === true) positional.push('help');
    else if (flags['version'] === true) positional.push('version');
  }

  let bootResult;
  try {
    bootResult = await bootConfig(flags);
  } catch (err) {
    process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const { paths, config: _config, vault } = bootResult;
  let config = _config;
  const { cwd, projectRoot, userHome, wpaths, pathResolver } = paths;
  void pathResolver; // used by callers via container binding

  const logger = new DefaultLogger({ level: config.log.level, file: wpaths.logFile });
  const renderer = new TerminalRenderer();
  const reader = new ReadlineInputReader({ historyFile: wpaths.historyFile });
  const modelsRegistry = new DefaultModelsRegistry({
    cacheFile: wpaths.modelsCache,
    ttlSeconds: 24 * 3600,
    // Curated overlay merged on top of models.dev: fetched from GitHub raw for
    // freshness, with the bundled file as the offline floor. The bundled file
    // is ALSO passed as the in-memory `overlay` so locally-added providers
    // (e.g. kiro) are always present even when the GitHub overlay lags.
    overlay: readBundledOverlay(),
    overlayUrl: GITHUB_PROVIDERS_OVERLAY_URL,
    overlayFile: resolveBundledOverlayFile(),
    overlayCacheFile: wpaths.modelsOverlayCache,
  });

  // Background update check — fires async, non-blocking.
  // If --no-check flag is set or WRONGSTACK_NO_CHECK=1, skip it.
  let updateInfo: UpdateInfo | undefined;
  if (!flags['no-check'] && !process.env['WRONGSTACK_NO_CHECK']) {
    // Fire-and-forget: boot doesn't wait, result attached to ctx for index.ts
    checkForUpdate()
      .then((info) => {
        updateInfo = info;
      })
      .catch(() => {
        // silent — never blocks boot
      });
  }

  // Quick path: subcommand dispatch
  const first = positional[0];
  if (first && subcommands[first]) {
    // Create container to get the SAME skillLoader instance that the main
    // interactive CLI uses. This ensures cache invalidation after
    // /skill-install propagates correctly to /skill and other commands.
    const container = createDefaultContainer({
      config,
      wpaths,
      logger,
      modelsRegistry,
      bundledSkillsDir: config.features.skills ? resolveBundledSkillsDir() : undefined,
    });
    const sessionStore = container.resolve(TOKENS.SessionStore);
    const skillLoader = container.resolve(TOKENS.SkillLoader);
    const toolRegistryForSubcmd = new ToolRegistry();
    toolRegistryForSubcmd.registerAllOrThrow(
      [...(builtinToolsPack.tools ?? [])],
      builtinToolsPack.name,
    );
    const code = await subcommands[first]!(positional.slice(1), {
      config,
      renderer,
      reader,
      sessionStore,
      skillLoader,
      toolRegistry: toolRegistryForSubcmd,
      modelsRegistry,
      paths: wpaths,
      vault,
      cwd,
      projectRoot,
      userHome,
    });
    await reader.close();
    return code;
  }

  const isSingleShot = positional.length > 0 || typeof flags['prompt'] === 'string';
  const isInteractiveTTY = !!process.stdin.isTTY && !isSingleShot;

  if (isInteractiveTTY) {
    const cont = await runProjectCheck({ projectRoot, renderer, reader });
    if (!cont) {
      await reader.close();
      return 0;
    }
  }

  // Provider + model selection
  const providerFlag = typeof flags['provider'] === 'string' ? flags['provider'] : undefined;
  const modelFlag = typeof flags['model'] === 'string' ? flags['model'] : undefined;
  if (!(!!providerFlag && !!modelFlag)) {
    if (process.stdin.isTTY) {
      const picked = await runPicker({
        modelsRegistry,
        renderer,
        reader,
        config,
        defaultProvider: providerFlag ?? config.provider,
        defaultModel: modelFlag ?? config.model,
      });
      if (!picked) {
        if (!config.provider || !config.model) {
          await reader.close();
          return 2;
        }
      } else {
        const prevProvider = config.provider;
        const prevModel = config.model;
        config = patchConfig(config, { provider: picked.provider, model: picked.model });
        if (picked.provider !== prevProvider || picked.model !== prevModel) {
          const saved = await saveToGlobalConfig(
            wpaths.globalConfig,
            picked.provider,
            picked.model,
          );
          if (saved) renderer.writeInfo(`Saved ${picked.provider}/${picked.model} as default.\n`);
        }
      }
    } else if (!config.provider || !config.model) {
      process.stderr.write(
        'No provider or model configured. Run `wrongstack init` first, or pass --provider <id> --model <id>.\n',
      );
      await reader.close();
      return 2;
    }
  }

  // Mode + YOLO + Director + Autonomy prompts
  if (isInteractiveTTY) {
    let modePinned: 'tui' | 'repl' | undefined;
    if (flags['no-tui']) modePinned = 'repl';
    else if (flags['tui']) modePinned = 'tui';
    const yoloPinned: boolean | undefined = flags['yolo'] === true ? true : undefined;
    let directorPinned: boolean | undefined;
    if (flags['director'] === true || typeof flags['resume'] === 'string') directorPinned = true;
    else if (flags['no-director'] === true) directorPinned = false;
    let autonomyPinned: 'off' | 'auto' | undefined;
    if (flags['no-autonomy'] === true) autonomyPinned = 'off';
    else if (flags['eternal'] === true) autonomyPinned = 'off'; // --eternal starts engine directly, skips launch-prompt autonomy
    else if (typeof flags['autonomy'] === 'string') {
      const v = (flags['autonomy'] as string).toLowerCase();
      autonomyPinned = v === 'off' || v === 'no' || v === 'false' ? 'off' : 'auto';
    } else if (flags['autonomy'] === true) {
      autonomyPinned = 'auto';
    }
    let choices: Awaited<ReturnType<typeof runLaunchPrompts>>;
    try {
      choices = await runLaunchPrompts({
        renderer,
        reader,
        modePinned,
        yoloPinned,
        directorPinned,
        autonomyPinned,
      });
    } catch (err) {
      if (err instanceof LaunchAbortedError) {
        await reader.close();
        return 0;
      }
      throw err;
    }
    if (choices.mode === 'tui') {
      flags['tui'] = true;
      flags['no-tui'] = false;
    } else {
      flags['tui'] = false;
      flags['no-tui'] = true;
    }
    if (choices.yolo !== config.yolo) config = patchConfig(config, { yolo: choices.yolo });
    if (choices.director) flags['director'] = true;
    flags['autonomy'] = choices.autonomy;

    printLaunchHints(renderer, flags, {
      cursorFile: path.join(wpaths.cacheDir, 'hint-cursor'),
    });
  }

  return {
    config,
    vault,
    wpaths,
    cwd,
    projectRoot,
    userHome,
    flags,
    positional,
    modelsRegistry,
    renderer,
    reader,
    logger,
    updateInfo,
  };
}
