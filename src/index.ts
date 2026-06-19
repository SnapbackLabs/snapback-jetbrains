// JetBrains integration — reads each IDE's recentProjects.xml to find the
// projects you work in, and reopens them on restore. What's open *right now* is
// resolved from live window titles (recentProjects.xml only updates on config
// save), so capture reflects the current session, not the last one.
import {
  cleanList,
  defineIntegration,
  idCodec,
  known,
  notRunning,
  planByKey,
  restoreByKey,
  unknown,
  type BuildContext,
  type CaptureContext,
  type CaptureItem,
  type DriftReport,
  type LayerPlan,
  type Live,
  type RestoreContext,
} from '@lockethq/snapback-sdk';
import { type AppAliases, collapseHome, expandHome, foregroundApps, openApp, osa, quitApp, runAppleScript, runningFrom, windowTitles } from '@lockethq/snapback-sdk/macos';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

interface Project {
  ide: string;
  path: string;
}
interface State {
  projects: Project[];
  running: string[];
}
/** A recent project as read from disk, with the (possibly stale) open flag and timestamp. */
interface RecentProject extends Project {
  opened: boolean;
  ts: number;
}

// Config-dir prefix (dirs look like `WebStorm2024.3`) → display name, which is
// what `open -a` and the Accessibility layer use.
const IDES: Record<string, string> = {
  IntelliJIdea: 'IntelliJ IDEA',
  WebStorm: 'WebStorm',
  PyCharm: 'PyCharm',
  GoLand: 'GoLand',
  CLion: 'CLion',
  RubyMine: 'RubyMine',
  PhpStorm: 'PhpStorm',
  Rider: 'Rider',
  DataGrip: 'DataGrip',
};

// System Events reports JetBrains IDEs by their lowercase executable name, so
// each display name carries the process aliases used to detect and target it.
const FAMILIES: AppAliases[] = [
  { display: 'IntelliJ IDEA', processNames: ['intellij idea', 'idea'] },
  { display: 'WebStorm', processNames: ['webstorm'] },
  { display: 'PyCharm', processNames: ['pycharm'] },
  { display: 'GoLand', processNames: ['goland'] },
  { display: 'CLion', processNames: ['clion'] },
  { display: 'RubyMine', processNames: ['rubymine'] },
  { display: 'PhpStorm', processNames: ['phpstorm'] },
  { display: 'Rider', processNames: ['rider'] },
  { display: 'DataGrip', processNames: ['datagrip'] },
];
const aliasesFor = (ide: string): string[] => FAMILIES.find((f) => f.display === ide)?.processNames ?? [];

const CONFIG_ROOT = (): string => join(homedir(), 'Library/Application Support/JetBrains');
const MAX_PROJECTS_PER_IDE = 8;

const projectKey = idCodec('jb', ['ide', 'path'] as const);
const projectId = (p: Project): string => projectKey.encode(p);
const projectItem = (p: Project): CaptureItem => ({ id: projectId(p), label: basename(p.path) || p.path, sub: p.ide });

function groupByIde(projects: Project[]): Map<string, Project[]> {
  const byIde = new Map<string, Project[]>();
  for (const p of projects) {
    const list = byIde.get(p.ide);
    if (list) list.push(p); else byIde.set(p.ide, [p]);
  }
  return byIde;
}

/** Newest config dir per known IDE prefix (lexicographically greatest version). */
function newestConfigDirs(root: string): Map<string, string> {
  const newest = new Map<string, string>();
  for (const dir of readdirSync(root)) {
    const prefix = Object.keys(IDES).find((p) => dir.startsWith(p));
    if (prefix && (!newest.has(prefix) || dir > newest.get(prefix)!)) newest.set(prefix, dir);
  }
  return newest;
}

/** Recent projects per IDE that still exist on disk, capped and sorted
 *  most-recently-opened first. The IDE only rewrites this file on config save,
 *  so its flags lag a running session — live window titles are the truth. */
function readRecentProjects(): RecentProject[] {
  const projects: RecentProject[] = [];
  const root = CONFIG_ROOT();
  try {
    for (const [prefix, dir] of newestConfigDirs(root)) {
      try {
        const xml = readFileSync(join(root, dir, 'options/recentProjects.xml'), 'utf8');
        const forIde: RecentProject[] = [];
        // Split on entry boundaries so attributes match within their own block.
        for (const block of xml.split('<entry key="').slice(1)) {
          const path = block.slice(0, block.indexOf('"')).replace('$USER_HOME$', homedir());
          if (!existsSync(path)) continue;
          forIde.push({
            ide: IDES[prefix],
            path,
            opened: /opened="true"/.test(block),
            ts: Number(/projectOpenTimestamp"\s+value="(\d+)"/.exec(block)?.[1] ?? 0),
          });
        }
        forIde.sort((a, b) => b.ts - a.ts);
        projects.push(...forIde.slice(0, MAX_PROJECTS_PER_IDE));
      } catch {
        // this IDE has no recent-projects file — skip it
      }
    }
  } catch {
    // no JetBrains config directory at all
  }
  return projects;
}

/** True when an IDE window title names this project. Titles look like
 *  "api – Main.java" or "api [~/code/api]"; only the space-delimited form is
 *  accepted so "api" never matches an "api-gateway" window. */
function titleNamesProject(titles: string[], projectPath: string): boolean {
  const name = basename(projectPath).toLowerCase();
  return !!name && titles.some((t) => t.toLowerCase() === name || t.toLowerCase().startsWith(`${name} `));
}

/** Projects open in a running IDE right now, by matching its window titles
 *  against the recent list. Unknown when no titles are readable (Accessibility
 *  denied, or on the Welcome screen) — callers must never close on unknown. */
async function liveProjects(ide: string, recent: RecentProject[]): Promise<Live<Project[]>> {
  for (const proc of aliasesFor(ide)) {
    const titles = await windowTitles(proc);
    if (titles.length > 0) {
      return known(recent.filter((p) => p.ide === ide && titleNamesProject(titles, p.path)).map(({ ide: i, path }) => ({ ide: i, path })));
    }
  }
  return unknown();
}

/** Close specific projects' windows by clicking each matching window's close
 *  button (there's no scriptable per-project close). */
async function closeProjectWindows(ide: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const conds = paths.map((p) => {
    const name = basename(p);
    return `t is ${osa.str(name)} or t begins with ${osa.str(`${name} `)}`;
  }).join(' or ');
  for (const proc of aliasesFor(ide)) {
    const script =
      'tell application "System Events"\n' +
      `  if exists (process ${osa.str(proc)}) then\n` +
      `    tell process ${osa.str(proc)}\n` +
      '      repeat with w in windows\n' +
      '        try\n' +
      '          set t to name of w\n' +
      `          if ${conds} then click (first button of w whose subrole is "AXCloseButton")\n` +
      '        end try\n' +
      '      end repeat\n' +
      '    end tell\n' +
      '  end if\n' +
      'end tell';
    await runAppleScript(script, { timeoutMs: 6000 });
  }
}

export default defineIntegration<State>({
  emptyState: { projects: [], running: [] },
  manifest: {
    id: 'com.focus.jetbrains',
    name: 'JetBrains IDEs',
    version: '1.0.0',
    schemaVersion: 1,
    by: 'Snapback Labs',
    category: 'Editors',
    description: 'Reopens your IntelliJ/WebStorm/PyCharm projects on restore.',
    platforms: ['darwin'],
    permissions: ['fs:read:jetbrains-config', 'process:spawn:jetbrains'],
    restorePriority: 1,
    appKey: 'intellij',
    tint: 'orange',
    detectsApps: [...FAMILIES.map((f) => f.display), ...FAMILIES.flatMap((f) => f.processNames)],
    layout: [{ x: 30, y: 6, w: 33, h: 52, tint: 'orange' }],
    builder: {
      blurb: 'Projects to reopen in a JetBrains IDE.',
      itemNoun: 'project',
      fields: [
        {
          kind: 'select', key: 'ide', label: 'IDE', default: 'IntelliJ IDEA',
          options: Object.values(IDES).map((name) => ({ value: name, label: name })),
        },
        {
          kind: 'list', key: 'projects', label: 'Projects', path: true,
          placeholder: '~/work/service',
          help: 'Absolute or ~ paths — each reopens in the selected IDE.',
        },
      ],
    },
  },
  async capture(ctx: CaptureContext) {
    const running = runningFrom(FAMILIES, ctx.runningApps ?? (await foregroundApps()));
    const recent = readRecentProjects();

    let projects: Project[] = [];
    for (const ide of running) {
      const forIde = recent.filter((p) => p.ide === ide);
      if (forIde.length === 0) continue;
      const live = await liveProjects(ide, recent);
      if (live.known) {
        projects.push(...live.value); // titles readable — the source of truth
      } else {
        // Fall back to the recent file's flags: the marked-open projects, else
        // the single most recent.
        const opened = forIde.filter((p) => p.opened);
        projects.push(...(opened.length ? opened : forIde.slice(0, 1)).map(({ ide: i, path }) => ({ ide: i, path })));
      }
    }
    if (ctx.select) projects = projects.filter((p) => ctx.select!.includes(projectId(p)));
    if (projects.length === 0) return notRunning({ projects: [], running: [] }, 'not running', 'no JetBrains IDE open');

    return {
      payload: { projects, running: [...new Set(projects.map((p) => p.ide))] },
      digest: { detail: `${projects.length} project${projects.length === 1 ? '' : 's'}`, sub: projects.map((p) => basename(p.path)).join(' · ') },
      items: projects.map(projectItem),
    };
  },
  async plan(state: State, ctx: CaptureContext): Promise<LayerPlan> {
    const running = runningFrom(FAMILIES, ctx.runningApps ?? (await foregroundApps()));
    const recent = readRecentProjects();
    const savedByIde = groupByIde(state.projects);

    const merged: LayerPlan = { open: [], close: [], keep: [] };
    for (const ide of new Set([...savedByIde.keys(), ...running])) {
      const part = planByKey({
        saved: savedByIde.get(ide) ?? [],
        live: running.includes(ide) ? await liveProjects(ide, recent) : known<Project[]>([]),
        keyOf: projectId,
        toItem: projectItem,
      });
      merged.open.push(...part.open);
      merged.close.push(...part.close);
      merged.keep.push(...part.keep);
    }
    return merged;
  },
  async restore(state: State, ctx: RestoreContext) {
    const running = runningFrom(FAMILIES, await foregroundApps());
    const recent = readRecentProjects();
    const savedByIde = groupByIde(state.projects);

    let opened = 0;
    let closed = 0;
    for (const ide of new Set([...savedByIde.keys(), ...running])) {
      const savedForIde = savedByIde.get(ide) ?? [];
      const { opened: o, closed: c } = await restoreByKey({
        desired: savedForIde.filter((p) => !ctx.skipItemIds.includes(projectId(p))),
        live: running.includes(ide) ? await liveProjects(ide, recent) : known<Project[]>([]),
        keyOf: projectId,
        keepKeys: ctx.keepItemIds,
        mode: ctx.mode,
        settleMs: 1500, // let new windows appear before counting what to close
        // Open with the IDE app (not `-n`): a second instance would conflict
        // with the running one and exit immediately.
        open: async (projects) => {
          for (const p of projects) await openApp(p.ide, { args: [p.path] });
        },
        close: async (toClose) => {
          // If the IDE isn't part of this snapshot at all, quit it whole;
          // otherwise close just the unwanted project windows.
          if (savedForIde.length === 0) await quitApp(ide);
          else await closeProjectWindows(ide, toClose.map((p) => p.path));
        },
      });
      opened += o.length;
      closed += c.length;
    }
    if (opened === 0 && closed === 0) return { ok: false, detail: 'nothing to restore' };
    const parts = [];
    if (opened) parts.push(`${opened} project${opened === 1 ? '' : 's'} reopened`);
    if (closed) parts.push(`${closed} closed`);
    return { ok: true, detail: parts.join(', ') };
  },
  async diff(state: State, ctx: CaptureContext): Promise<DriftReport> {
    const ides = [...new Set(state.projects.map((p) => p.ide))];
    if (ides.length === 0) return { score: 100, changed: [] };
    const running = runningFrom(FAMILIES, ctx.runningApps ?? (await foregroundApps()));
    const missing = ides.filter((ide) => !running.includes(ide));
    return { score: Math.round(((ides.length - missing.length) / ides.length) * 100), changed: missing.map((ide) => `${ide} not running`) };
  },
  build(ctx: BuildContext) {
    const ide = Object.values(IDES).includes(ctx.values.ide as string) ? (ctx.values.ide as string) : 'IntelliJ IDEA';
    const paths = cleanList(ctx.values.projects).map(expandHome);
    if (paths.length === 0) return null;
    const projects = paths.map((path) => ({ ide, path }));
    return {
      payload: { projects, running: [ide] },
      digest: { detail: `${projects.length} project${projects.length === 1 ? '' : 's'}`, sub: projects.map((p) => basename(p.path)).join(' · ') },
      items: projects.map(projectItem),
    };
  },
  toBuild(state) {
    if (state.projects.length === 0) return null;
    return { ide: state.projects[0].ide, projects: state.projects.map((p) => collapseHome(p.path)) };
  },
  itemsOf(state) {
    return state.projects.map(projectItem);
  },
  removeItem(state, itemId) {
    return { ...state, projects: state.projects.filter((p) => projectId(p) !== itemId) };
  },
  healthCheck() {
    if (!existsSync(CONFIG_ROOT())) return { ok: false, detail: 'no JetBrains IDEs found' };
    return { ok: true };
  },
});
