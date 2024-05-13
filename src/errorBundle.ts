/**
 * A port of Zig's ErrorBundle.
 *
 * See [ErrorBundle.zig](https://github.com/ziglang/zig/blob/master/lib/std/zig/ErrorBundle.zig)
 */
export class ErrorBundle {
    stringBytes: Uint8Array;
    extra: Uint32Array;

    constructor(stringBytes?: Uint8Array, extra?: Uint32Array) {
        this.stringBytes = stringBytes ?? new Uint8Array();
        this.extra = extra ?? new Uint32Array();
    }

    errorMessageCount(): number {
        if (this.extra.length === 0) return 0;
        return this.getErrorMessageList().len;
    }

    getErrorMessageList(): ErrorMessageList {
        return {
            len: this.extra[0],
            start: this.extra[1],
            compileLogText: this.extra[2],
        };
    }

    getMessages(): MessageIndex[] {
        const list = this.getErrorMessageList();
        const indices = this.extra.subarray(list.start, list.start + list.len);
        return Array.from(indices, (value) => value as MessageIndex);
    }

    getErrorMessage(index: MessageIndex): ErrorMessage {
        const srcLoc = this.extra[index + 2];
        return {
            msg: this.extra[index] as StringIndex,
            count: this.extra[index + 1],
            srcLoc: srcLoc !== 0 ? (srcLoc as SourceLocationIndex) : undefined,
            notesLen: this.extra[index + 3],
        };
    }

    getSourceLocation(index: SourceLocationIndex): SourceLocation {
        const sourceLine = this.extra[index + 6];
        return {
            srcPath: this.extra[index] as StringIndex,
            line: this.extra[index + 1],
            column: this.extra[index + 2],
            spanStart: this.extra[index + 3],
            spanMain: this.extra[index + 4],
            spanEnd: this.extra[index + 5],
            sourceLine: sourceLine !== 0 ? (sourceLine as StringIndex) : undefined,
            referenceTraceLen: this.extra[index + 7],
        };
    }

    getReferenceTrace(index: ReferenceTraceIndex): ReferenceTrace {
        const srcLoc = this.extra[index + 1];
        if (srcLoc === 0) {
            return { hiddenReferences: srcLoc } as ReferenceTraceSentinel;
        } else {
            return {
                declName: this.extra[index] as StringIndex,
                srcLoc: srcLoc,
            } as ReferenceTraceNode;
        }
    }

    getNotes(index: MessageIndex): MessageIndex[] {
        const notesLen = this.getErrorMessage(index).notesLen;
        const start = index + 4;
        return Array.from(this.extra.subarray(start, start + notesLen), (value) => value as MessageIndex);
    }

    getReferenceTraces(index: SourceLocationIndex): ReferenceTraceIndex[] {
        const referenceTraceLen = this.getSourceLocation(index).referenceTraceLen;
        const start = index + 8;
        return Array.from(
            this.extra.subarray(start, start + referenceTraceLen),
            (value) => value as ReferenceTraceIndex,
        );
    }

    getCompileLogOutput(): string {
        return this.nullTerminatedString(this.getErrorMessageList().compileLogText);
    }

    nullTerminatedString(index: number): string {
        const end = this.stringBytes.indexOf(0, index);
        return Buffer.from(this.stringBytes.subarray(index, end)).toString();
    }

    /**
     * @deprecated This method is incomplete and has not been fully tested.
     */
    toString(
        options: RenderOptions = {
            includeReferenceTrace: true,
            includeSourceLine: true,
            includeLogText: true,
        },
    ): string {
        const str: string[] = [];
        for (const errMsg of this.getMessages()) {
            this.renderErrorMessage(str, options, errMsg, "error", 0);
        }
        if (options.includeLogText) {
            const logText = this.getCompileLogOutput();
            if (logText.length !== 0) {
                str.push("\nCompile Log Output:\n", logText);
            }
        }
        return str.join("");
    }

    private renderErrorMessage(
        str: string[],
        options: RenderOptions,
        errMsgIndex: MessageIndex,
        kind: string,
        indent: number,
    ) {
        const errMsg = this.getErrorMessage(errMsgIndex);
        const msg = this.nullTerminatedString(errMsg.msg);
        if (errMsg.srcLoc) {
            const src = this.getSourceLocation(errMsg.srcLoc);
            const prefixWhitespace = " ".repeat(indent);
            str.push(
                prefixWhitespace,
                this.nullTerminatedString(src.srcPath),
                `:${(src.line + 1).toString()}:${(src.column + 1).toString()}: ${kind}: `,
            );
            const indentedMsg = msg.replace("\n", prefixWhitespace);
            if (errMsg.count === 1) {
                str.push(indentedMsg, "\n");
            } else {
                str.push(`${indentedMsg} (${errMsg.count.toString()} times)\n`);
            }
            if (src.sourceLine && options.includeSourceLine) {
                const line = this.nullTerminatedString(src.sourceLine);
                str.push(line.replace("\t", " "), "\n");
                // TODO basic unicode code point monospace width
                const beforeCaret = src.spanMain - src.spanStart;
                // -1 since span.main includes the caret
                const afterCaret = Math.min(0, src.spanEnd - src.spanMain - 1);
                str.push(
                    " ".repeat(src.column - beforeCaret),
                    "~".repeat(beforeCaret),
                    "^",
                    "~".repeat(afterCaret),
                    "\n",
                );
            }
            // NOTE: I just gave up here since this code isn't used anyway.
        } else {
            str.push(`${" ".repeat(indent)}${kind}: `);
            if (errMsg.count === 1) {
                str.push(msg, "\n");
            } else {
                str.push(`${msg} (${errMsg.count.toString()} times)\n`);
            }
            for (const note of this.getNotes(errMsgIndex)) {
                this.renderErrorMessage(str, options, note, "note", indent + 4);
            }
        }
    }
}

export interface RenderOptions {
    includeReferenceTrace: boolean;
    includeSourceLine: boolean;
    includeLogText: boolean;
}

/** There will be a `MessageIndex` for each `len` at `start`. */
export interface ErrorMessageList {
    len: number;
    start: number;
    /** null-terminated string index. 0 means no compile log text. */
    compileLogText: number;
}

/**
 * Trailing:
 * - `ReferenceTrace` for each `referenceTraceLen`
 */
export interface SourceLocation {
    srcPath: StringIndex;
    line: number;
    column: number;
    /** byte offset of starting token */
    spanStart: number;
    /** byte offset of main error location */
    spanMain: number;
    /** byte offset of end of last token */
    spanEnd: number;
    /** Does not include the trailing newline. */
    sourceLine?: StringIndex;
    referenceTraceLen: number;
}

/**
 * Trailing:
 * - `MessageIndex` for each `notesLen`.
 */
export interface ErrorMessage {
    msg: StringIndex;
    /** Usually one, but incremented for redundant messages. */
    count: number;
    srcLoc?: SourceLocationIndex;
    notesLen: number;
}

export type ReferenceTrace = ReferenceTraceNode | ReferenceTraceSentinel;

interface ReferenceTraceNode {
    declName: StringIndex;
    srcLoc: SourceLocationIndex;
}

interface ReferenceTraceSentinel {
    /**
     * - 0 means remaining references hidden
     * - >0 means N references hidden
     */
    hiddenReferences: number;
}

/** An index into `stringBytes` pointing at a null terminated string. */
export declare type StringIndex = number & { kind: "StringIndex" };

/** An index into `extra` pointing at an `ErrorMessage`. */
export declare type MessageIndex = number & { kind: "MessageIndex" };

/** An index into `extra` pointing at a `SourceLocation`. */
export declare type SourceLocationIndex = number & { kind: "SourceLocationIndex" };

/** An index into `extra` pointing at a `ReferenceTrace`. */
export declare type ReferenceTraceIndex = number & { kind: "ReferenceTrace" };
