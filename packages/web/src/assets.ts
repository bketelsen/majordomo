/**
 * Static asset imports for compiled builds
 * 
 * These files are bundled into the executable at compile time.
 * In development mode, we fall back to reading from disk.
 */

// Detect if running as compiled binary
export function isCompiledBinary(): boolean {
  // In compiled binaries, import.meta.path is inside Bun's virtual fs (/$bunfs/)
  // In source mode, it's a real filesystem path ending in .ts
  return import.meta.path.startsWith('/$bunfs/') || import.meta.path.startsWith('/bunfs/');
}

// Embedded HTML dashboard
// @ts-ignore — bun 'with { type: text }' imports not supported by tsc
import indexHTMLRaw from '../static/index.html' with { type: 'text' };
export const indexHTML: string = indexHTMLRaw as unknown as string;

// Default agent definitions (shipped with binary)
// @ts-ignore
import researcherRaw from '../../../agents/researcher.md' with { type: 'text' };
// @ts-ignore
import architectRaw from '../../../agents/architect.md' with { type: 'text' };
// @ts-ignore
import developerRaw from '../../../agents/developer.md' with { type: 'text' };
// @ts-ignore
import qaRaw from '../../../agents/qa.md' with { type: 'text' };
export const defaultAgents: Record<string, string> = {
  researcher: researcherRaw as unknown as string,
  architect: architectRaw as unknown as string,
  developer: developerRaw as unknown as string,
  qa: qaRaw as unknown as string,
};

// Default workflow definitions
// @ts-ignore
import rtiRaw from '../../../workflows/research-to-implementation.yaml' with { type: 'text' };
export const defaultWorkflows: Record<string, string> = {
  'research-to-implementation': rtiRaw as unknown as string,
};

// Persona file
// @ts-ignore
import personaRaw from '../../agent/persona/majordomo.md' with { type: 'text' };
export const personaContent: string = personaRaw as unknown as string;
