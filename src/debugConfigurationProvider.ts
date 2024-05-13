import vscode from "vscode";

import fs from "fs";
import path from "path";

import { ErrorBundle, SourceLocation } from "./errorBundle";
import { getZigPath } from "./zigUtil";
import { zigServe } from "./zigCompileServer";

interface DebugConfiguration extends vscode.DebugConfiguration {
    type: string;
    name: string;
    request: string;
    args?: string[];
    [key: string]: unknown;
}

export class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    private buildDiagnostics: vscode.DiagnosticCollection;

    constructor(buildDiagnostics: vscode.DiagnosticCollection) {
        this.buildDiagnostics = buildDiagnostics;
    }

    provideDebugConfigurations(
        folder: vscode.WorkspaceFolder | undefined,
        token?: vscode.CancellationToken,
    ): vscode.ProviderResult<DebugConfiguration[]> {
        token;
        const folderHasBuildSystem = folder && fs.existsSync(path.join(folder.uri.fsPath, "build.zig"));

        if (folderHasBuildSystem) {
            return [
                {
                    type: "zig",
                    name: "Launch zig build run",
                    request: "launch",
                    args: ["build", "run"],
                },
                {
                    type: "zig",
                    name: "Launch zig build test",
                    request: "launch",
                    args: ["build", "test"],
                },
            ];
        } else {
            // TODO check if placeholders like `${1:Program}` can be used
            return [
                {
                    type: "zig",
                    name: "Launch zig run main.zig",
                    request: "launch",
                    args: ["run", "${workspaceFolder}/src/main.zig"],
                },
                {
                    type: "zig",
                    name: "Launch zig test main.zig",
                    request: "launch",
                    args: ["test", "${workspaceFolder}/src/main.zig"],
                },
            ];
        }
    }

    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        debugConfiguration: DebugConfiguration,
        token?: vscode.CancellationToken,
    ): Promise<DebugConfiguration | null | undefined> {
        if (vscode.extensions.getExtension("vadimcn.vscode-lldb") === undefined) {
            const response = await vscode.window.showWarningMessage(
                `Debugging requires the [CodeLLDB](https://github.com/vadimcn/codelldb) extension`,
                "Install",
                "Show Extension",
            );
            switch (response) {
                case "Install":
                    await vscode.commands.executeCommand("extension.open", "vadimcn.vscode-lldb");
                    await vscode.commands.executeCommand(
                        "workbench.extensions.installExtension",
                        "vadimcn.vscode-lldb",
                        {
                            enable: true, // TODO figure out why this is being ignored
                        },
                    );
                    return;
                case "Show Extension":
                    await vscode.commands.executeCommand("extension.open", "vadimcn.vscode-lldb");
                    return;
                case undefined:
                    return;
            }
        }

        const hasDebugConfiguration = (debugConfiguration.request as string | undefined) !== undefined;

        if (!hasDebugConfiguration) {
            const folderHasBuildSystem = folder && fs.existsSync(path.join(folder.uri.fsPath, "build.zig"));
            // TODO test what happens when `folder === null` and we return null instead.
            if (folderHasBuildSystem) {
                // Returning `null` will create a launch.json with the configuration(s) returned by `provideDebugConfigurations`
                return null;
            }

            const activeDocument = vscode.window.activeTextEditor?.document;
            if (!activeDocument) {
                return undefined;
            }

            // TODO Zig can compile more that just `.zig` files.
            if (activeDocument.languageId !== "zig") {
                return undefined;
            }

            // We could check if the file contains a `main` function or tests.
            // This could then be used to remove the 'run' or 'test' quick pick.
            // Or skip this entirely and instead create a launch.json
            const selection = await vscode.window.showQuickPick(
                [
                    {
                        label: "run",
                        description: "zig build run",
                        detail: "run main function in the current file",
                        picked: true,
                    },
                    {
                        label: "test",
                        description: "zig build test",
                        detail: "run all test in the current file",
                        picked: false,
                    },
                    {
                        label: "",
                        kind: vscode.QuickPickItemKind.Separator,
                    },
                    {
                        label: "open launch.json",
                    },
                ],
                {
                    canPickMany: false,
                    title: "Select how to execute current file",
                },
                token,
            );

            switch (selection?.label) {
                case "run":
                case "test":
                    return {
                        type: "zig",
                        name: `Launch zig ${selection.label} \${file}`,
                        request: "launch",
                        args: [selection.label, "${file}"],
                    };
                case "open launch.json":
                    return null;
                case undefined:
                    return undefined;
            }
        }

        if (!debugConfiguration.args) {
            void vscode.window.showErrorMessage("invalid launch.json configuration: missing property 'args'");
            return null;
        } else if (!debugConfiguration.args[0]) {
            void vscode.window.showErrorMessage(
                "invalid launch.json configuration: 'args' must have at least one argument",
            );
            return null;
        }

        switch (debugConfiguration.args[0]) {
            case "build": {
                // resolve the `--build-file` option
                const hasExplicitBuildFile = debugConfiguration.args.find((value) => value === "--build-file");
                if (!hasExplicitBuildFile) {
                    if (!folder) {
                        void vscode.window.showErrorMessage(
                            "Debug configuration for 'zig build' requires a workspace folder. Open a workspace folder or specify '--build-file' in 'args'.",
                        );
                        return undefined;
                    }
                    debugConfiguration.args.push("--build-file", "${workspaceFolder}/build.zig");
                }
                break;
            }
            case "run":
            case "test":
                break;
            default:
                void vscode.window.showErrorMessage(`unexpected build mode ${debugConfiguration.args[0]}`);
                return null;
        }

        return debugConfiguration;
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        debugConfiguration: DebugConfiguration,
        token?: vscode.CancellationToken,
    ): Promise<DebugConfiguration | null | undefined> {
        token; // TODO support cancellation

        const args = debugConfiguration.args ?? [];
        const [buildArgs, runArgs] = splitBuildAndRunArgs(args);
        // TODO make the type configurable
        debugConfiguration.type = "lldb";
        debugConfiguration.args = runArgs;

        switch (args[0]) {
            case "build": {
                const buildFilePath = buildArgs[1 + buildArgs.findIndex((value) => value === "--build-file")];
                if (!buildFilePath) {
                    // '--build-file' has been manually specified but it is not followed by another argument.
                    return null;
                }
                if (!fs.existsSync(buildFilePath)) {
                    void vscode.window.showErrorMessage(`could not find '${buildFilePath}'`);
                    return null;
                }
                // TODO: make the magic happen!
                debugConfiguration.program = "/home/techatrix/repos/zls/zig-out/bin/zls";
                return debugConfiguration;
            }
            case "run":
            case "test": {
                const sourceFiles: string[] = buildArgs.slice(1).filter((arg) => !arg.startsWith("-"));
                const sourceFileBasenames = sourceFiles.map((file) => path.basename(file));
                const sourcesString = sourceFileBasenames.join(" ");

                // TODO: When there are multiple source files, how do you choose the base path?
                // An example invocation would be `zig run -x c -lc /some/absolute/path/path.c /some/other/absolute/path.c`
                const baseUri = folder?.uri ?? vscode.Uri.file(path.dirname(sourceFiles[0]));

                const buildMode = args[0] === "run" ? "build-exe" : "test";

                let result;
                try {
                    result = await vscode.window.withProgress(
                        {
                            title: `compiling 'zig ${args[0]} ${sourcesString}'...`,
                            location: vscode.ProgressLocation.Notification,
                            cancellable: false, // TODO support cancellation
                        },
                        (progress) =>
                            // TODO find the Zig version that introduced `--listen` and check that `zig version` is new enough
                            zigServe({
                                zigExePath: getZigPath(),
                                args: [buildMode].concat(buildArgs.slice(1)),
                                cwd: folder?.uri.fsPath,
                                onProgress: (message) => {
                                    progress.report({ message: message });
                                },
                            }),
                    );
                } catch {
                    void vscode.window.showErrorMessage(`failed to compile 'zig ${args[0]} ${sourcesString}'`);
                    return undefined;
                }

                if (result.success) {
                    debugConfiguration.name;
                    debugConfiguration.request;
                    debugConfiguration.program = result.path;
                    return debugConfiguration;
                } else {
                    this.updateBuildDiagnosticsFromErrorBundle(baseUri, result.errorBundle);
                    return undefined;
                }
            }
            default: {
                void vscode.window.showErrorMessage(`unexpected build mode ${args[0]}`);
                return null;
            }
        }
    }

    public updateBuildDiagnosticsFromErrorBundle(baseUri: vscode.Uri, errorBundle: ErrorBundle) {
        const diagnostics: Record<string, vscode.Diagnostic[] | undefined> = {};
        for (const msgIndex of errorBundle.getMessages()) {
            const errorMessage = errorBundle.getErrorMessage(msgIndex);
            const message = errorBundle.nullTerminatedString(errorMessage.msg);
            if (!errorMessage.srcLoc) {
                // TODO is there something better than this?
                // It would also be possible to show the error on the first line of the file.
                void vscode.window.showErrorMessage(message);
                continue;
            }
            const srcLoc = errorBundle.getSourceLocation(errorMessage.srcLoc);
            const srcPath = errorBundle.nullTerminatedString(srcLoc.srcPath);

            const diagnostic: vscode.Diagnostic = {
                range: sourceLocationToRange(srcLoc),
                message: message,
                severity: vscode.DiagnosticSeverity.Error,
                source: "zig",
            };

            for (const noteIndex of errorBundle.getNotes(msgIndex)) {
                if (!diagnostic.relatedInformation) {
                    diagnostic.relatedInformation = [];
                }
                const noteMessage = errorBundle.getErrorMessage(noteIndex);

                // use the range of the error if no source location is available
                const noteSrcLoc = noteMessage.srcLoc ? errorBundle.getSourceLocation(noteMessage.srcLoc) : srcLoc;

                const srcUri = path.isAbsolute(srcPath)
                    ? vscode.Uri.file(srcPath)
                    : vscode.Uri.joinPath(baseUri, srcPath);
                diagnostic.relatedInformation.push({
                    location: {
                        range: sourceLocationToRange(noteSrcLoc),
                        uri: srcUri,
                    },
                    message: errorBundle.nullTerminatedString(noteMessage.msg),
                });
            }

            const diagnosticArray = diagnostics[srcPath] ?? [];
            diagnosticArray.push(diagnostic);
            diagnostics[srcPath] = diagnosticArray;
        }

        this.buildDiagnostics.clear();
        for (const [srcPath, diagnostic] of Object.entries(diagnostics)) {
            const srcUri = path.isAbsolute(srcPath) ? vscode.Uri.file(srcPath) : vscode.Uri.joinPath(baseUri, srcPath);
            this.buildDiagnostics.set(srcUri, diagnostic);
        }
    }
}

export function splitBuildAndRunArgs(args: string[]): [string[], string[]] {
    const argsSeperator = args.findIndex((arg) => arg === "--");
    if (argsSeperator === -1) {
        return [args, []];
    } else {
        return [args.slice(0, argsSeperator), args.slice(argsSeperator + 1)];
    }
}

function sourceLocationToRange(sourceLocation: SourceLocation): vscode.Range {
    // The endCharacter will be incorrect when dealing non ascii characters since
    // spanEnd and spanStart count bytes while vscode.Position uses codepoints.
    const spanLength = sourceLocation.spanEnd - sourceLocation.spanStart;
    return new vscode.Range(
        sourceLocation.line,
        sourceLocation.column,
        sourceLocation.line,
        sourceLocation.column + spanLength,
    );
}
