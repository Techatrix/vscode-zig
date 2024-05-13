import vscode from "vscode";

import { ZigFormatProvider, ZigRangeFormatProvider } from "./zigFormat";
import { activate as activateZls, deactivate as deactivateZls } from "./zls";
import ZigCompilerProvider from "./zigCompilerProvider";
import { setupZig } from "./zigSetup";

const ZIG_MODE: vscode.DocumentFilter = { language: "zig", scheme: "file" };

export async function activate(context: vscode.ExtensionContext) {
    await setupZig(context).finally(() => {
        const buildDiagnostics = vscode.languages.createDiagnosticCollection("zig");
        context.subscriptions.push(buildDiagnostics);

        const compiler = new ZigCompilerProvider(buildDiagnostics);
        compiler.activate(context.subscriptions);

        if (vscode.workspace.getConfiguration("zig").get<string>("formattingProvider") === "extension") {
            context.subscriptions.push(
                vscode.languages.registerDocumentFormattingEditProvider(ZIG_MODE, new ZigFormatProvider()),
            );
            context.subscriptions.push(
                vscode.languages.registerDocumentRangeFormattingEditProvider(ZIG_MODE, new ZigRangeFormatProvider()),
            );
        }

        void activateZls(context, buildDiagnostics);
    });
}

export async function deactivate() {
    await deactivateZls();
}
