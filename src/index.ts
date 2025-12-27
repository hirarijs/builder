import { build, Plugin, formatMessages } from 'esbuild';
import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { globSync } from 'glob';
import stripJsonComments from 'strip-json-comments';
import cac from 'cac';
import { createMatchPath } from 'tsconfig-paths';
import { performance } from 'perf_hooks';
import ts from 'typescript';

const tsconfigPathsPlugin = (options: { tsconfigPath: string }): Plugin => {
  return {
    name: 'tsconfig-paths',
    setup(pluginBuild) {
      const { tsconfigPath } = options;
      const tsconfigDir = path.dirname(tsconfigPath);

      let tsconfigData: string;
      try {
        tsconfigData = readFileSync(tsconfigPath, 'utf8');
      } catch (err) {
        console.error(`Failed to read tsconfig file at: ${tsconfigPath}`);
        return;
      }
      
      const { compilerOptions } = JSON.parse(stripJsonComments(tsconfigData));

      if (!compilerOptions.paths) {
        return; // No paths to resolve
      }
      
      const resolvedBase = path.resolve(tsconfigDir, compilerOptions.baseUrl || '.');
      const pathKeys = Object.keys(compilerOptions.paths);
      const filter = new RegExp(`^(${pathKeys.map(key => key.replace('*', '.*')).join('|')})`);
      const match = createMatchPath(resolvedBase, compilerOptions.paths);

      pluginBuild.onResolve({ filter }, (args) => {
        const resolved = match(args.path, undefined, undefined, ['.ts', '.tsx', '.js', '.jsx', '.json']);
        if (resolved) {
          // If tsconfig-paths resolves a path, but it doesn't have an extension,
          // we need to manually check for it.
          if (!path.extname(resolved)) {
            const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json'];
            for (const ext of extensions) {
              const filePath = `${resolved}${ext}`;
              try {
                if (existsSync(filePath) && statSync(filePath).isFile()) {
                  return { path: filePath };
                }
              } catch (e) {
                // Ignore errors from statSync, like for broken symlinks
              }
            }
            // Also check for index file if it's a directory
            for (const ext of extensions) {
              const filePath = `${resolved}/index${ext}`;
              try {
                if (existsSync(filePath) && statSync(filePath).isFile()) {
                  return { path: filePath };
                }
              } catch (e) {
                // Ignore errors from statSync
              }
            }
          } else {
            // If it already has an extension, just return it
            return { path: resolved };
          }
        }
        return undefined;
      });
    },
  };
};

function moduleToFormat(moduleOption?: string): 'cjs' | 'esm' {
  if (!moduleOption) return 'cjs'; // Align with TypeScript's default (commonjs)
  const normalized = moduleOption.toLowerCase();
  if (normalized.includes('commonjs')) return 'cjs';
  // Node16/NodeNext produce native ESM output; treat as esm for esbuild.
  return 'esm';
}

function emitDeclarations(tsconfigPath: string, outdir: string): boolean {
  const configResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configResult.error) {
    console.error(ts.formatDiagnosticsWithColorAndContext([configResult.error], {
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getCanonicalFileName: fileName => fileName,
      getNewLine: () => ts.sys.newLine,
    }));
    return false;
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configResult.config,
    ts.sys,
    path.dirname(tsconfigPath),
    {
      declaration: true,
      emitDeclarationOnly: true,
      outDir: outdir,
      declarationDir: outdir,
      noEmit: false,
    },
    tsconfigPath,
  );

  const program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
    projectReferences: parsedConfig.projectReferences,
  });

  const emitResult = program.emit(undefined, undefined, undefined, true);
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

  if (diagnostics.length > 0) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getCanonicalFileName: fileName => fileName,
        getNewLine: () => ts.sys.newLine,
      }),
    );
    console.error('Declaration emit failed due to TypeScript errors.');
    return false;
  }

  return true;
}

async function runBuild(options: {
  project: string;
  showDuration?: boolean;
  listOutput?: boolean;
  bundle?: boolean;
  dts?: boolean;
  format?: 'cjs' | 'esm' | 'iife';
}) {
  try {
    const tsconfigPath = path.resolve(process.cwd(), options.project);
    const tsconfigDir = path.dirname(tsconfigPath);
    const tsconfigRaw = readFileSync(tsconfigPath, 'utf8');
    const tsconfig = JSON.parse(stripJsonComments(tsconfigRaw));

    const { compilerOptions, include, exclude, files } = tsconfig;
    const shouldBundle = options.bundle === true;
    const format = options.format ?? moduleToFormat(compilerOptions?.module);

    let entryPoints: string[] = [];
    if (files) {
      entryPoints = files.map((file: string) => path.resolve(tsconfigDir, file));
    } else if (include && Array.isArray(include)) {
      const includePatterns = include.map((pattern: string) => {
        const absPattern = path.resolve(tsconfigDir, pattern);
        try {
          if (statSync(absPattern).isDirectory()) {
            return path.join(pattern, '**/*');
          }
        } catch {
          // If stat fails, fall back to the raw pattern
        }
        return pattern;
      });

      entryPoints = globSync(includePatterns, {
        cwd: tsconfigDir,
        ignore: exclude,
        absolute: true,
        nodir: true,
      }).filter(filePath => {
        try {
          return statSync(filePath).isFile();
        } catch {
          return false;
        }
      });

      // If bundling, esbuild expects a single entry point.
      // If multiple entry points are found by glob, we should pick the primary one.
      // For simplicity, we'll take the first one for now.
      if (shouldBundle && entryPoints.length > 1) {
        // Find the main entry point if possible, e.g., 'main.ts' or 'index.ts'
        const mainEntry = entryPoints.find(ep => ep.endsWith('main.ts') || ep.endsWith('index.ts'));
        if (mainEntry) {
          entryPoints = [mainEntry];
        } else {
          entryPoints = [entryPoints[0]];
        }
      }
    }

    if (entryPoints.length === 0) {
      console.error('No entry points found. Please check your tsconfig.json "files" or "include" fields.');
      process.exit(1);
    }

    const outdir = compilerOptions?.outDir
      ? path.resolve(tsconfigDir, compilerOptions.outDir)
      : path.join(tsconfigDir, 'dist');

    const start = performance.now();
    let result;
    try {
      result = await build({
        entryPoints,
        outdir,
        target: compilerOptions?.target?.toLowerCase(),
        sourcemap: compilerOptions?.sourceMap,
        jsx: compilerOptions?.jsx,
        jsxFactory: compilerOptions?.jsxFactory,
        jsxFragment: compilerOptions?.jsxFragmentFactory,
        bundle: shouldBundle,
        platform: 'node',
        absWorkingDir: tsconfigDir,
        metafile: options.listOutput ?? false,
        format,
        plugins: [tsconfigPathsPlugin({ tsconfigPath })],
      });
    } catch (error: unknown) {
      const errWithMessages = error as { errors?: any[] };
      if (errWithMessages?.errors?.length) {
        const formatted = await formatMessages(errWithMessages.errors, { kind: 'error', color: true });
        console.error(formatted.join('\n'));
      } else {
        console.error('Build failed:', error);
      }
      process.exit(1);
    }

    const durationMs = performance.now() - start;
    const suffix: string[] = [];
    if (options.showDuration) {
      suffix.push(`⏱️ ${durationMs.toFixed(0)} ms`);
    }

    if (options.listOutput && result.metafile?.outputs) {
      const outputs = Object.keys(result.metafile.outputs)
        .map(outputPath => path.resolve(tsconfigDir, outputPath))
        .sort();
      console.log('🗂️ Outputs:');
      outputs.forEach(output => console.log(`  • ${output}`));
    }

    if (options.dts !== false) {
      const ok = emitDeclarations(tsconfigPath, outdir);
      if (!ok) {
        process.exit(1);
      }
    }

    console.log(`✨ Build finished successfully!${suffix.length ? ` (${suffix.join(', ')})` : ''}`);
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

const cli = cac('@hirarijs/builder');

cli
  .command('', 'Run the build')
  .option('-p, --project <path>', 'Path to the tsconfig.json file', {
    default: 'tsconfig.json',
  })
  .option('--show-duration', 'Print build duration in milliseconds', {
    default: false,
  })
  .option('--list-output', 'List generated output files (enables esbuild metafile)', {
    default: false,
  })
  .option('--bundle', 'Bundle entry points (use --no-bundle to emit separate outputs)', {
    default: false,
  })
  .option('--dts', 'Emit .d.ts files (use --no-dts to skip)', {
    default: true,
  })
  .option('--format <format>', 'Output format: cjs | esm | iife (default derives from tsconfig compilerOptions.module)', {})
  .action(runBuild);

cli.help();
cli.version('0.1.0');

cli.parse();
