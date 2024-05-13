import * as cp from "child_process";
import { ErrorBundle } from "./errorBundle";

export type ZigServerResult =
    | {
          success: true;
          path: string;
      }
    | {
          success: false;
          errorBundle: ErrorBundle;
      };

export async function zigServe(options: {
    zigExePath: string;
    args: string[];
    cwd?: string | URL | undefined;
    onProgress: (message: string) => void;
}): Promise<ZigServerResult> {
    return new Promise((resolve, reject) => {
        const args = options.args.concat("--listen=-");

        const childProcess = cp.execFile(
            options.zigExePath,
            args,
            {
                cwd: options.cwd,
                encoding: "buffer",
            },
            (error) => {
                reject(error ?? new Error(`failed to run '${options.zigExePath} ${args.join(" ")}'`));
            },
        );

        {
            // send update and exit message
            const messageBuffer = Buffer.alloc(16);
            messageBuffer.writeUInt32LE(1, 0); // tag=1 (update)
            messageBuffer.writeUInt32LE(0, 4); // bytes_len=0
            messageBuffer.writeUInt32LE(0, 8); // tag=0 (exit)
            messageBuffer.writeUInt32LE(0, 12); // bytes_len=0
            childProcess.stdin?.write(messageBuffer);
        }

        let dataBuffer = Buffer.alloc(0);
        childProcess.stdout?.on("data", (stdout: Buffer) => {
            dataBuffer = Buffer.concat([dataBuffer, stdout]);

            if (dataBuffer.length >= 8) {
                const tag = dataBuffer.readUInt32LE(0);
                const bytesLen = dataBuffer.readUInt32LE(4);
                const data = dataBuffer.subarray(8, 8 + bytesLen);
                dataBuffer = dataBuffer.subarray(8 + bytesLen);

                switch (tag) {
                    case 0: {
                        // zig_version
                        break;
                    }
                    case 1: {
                        // error_bundle
                        if (data.length < 8) {
                            reject(new Error("received error bundle with insufficient size"));
                            return;
                        }

                        const extraLen = data.readUInt32LE(0);
                        const stringBytesLen = data.readUInt32LE(4);
                        const errorBundleData = data.subarray(8);
                        if (bytesLen !== 8 + 4 * extraLen + stringBytesLen) {
                            reject(new Error("error bundle data mismatch"));
                            return;
                        }

                        const stringBytes = errorBundleData.subarray(4 * extraLen);

                        const extraData = errorBundleData.subarray(0, 4 * extraLen);
                        const extra = new Uint32Array(extraLen);
                        extra.forEach((_, index) => {
                            extra[index] = extraData.readUInt32LE(4 * index);
                        });

                        resolve({
                            success: false,
                            errorBundle: new ErrorBundle(stringBytes, extra),
                        });
                        return;
                    }
                    case 2: {
                        // progress
                        options.onProgress(data.toString("utf8"));
                        break;
                    }
                    case 3: {
                        // emit_bin_path

                        // first byte is std.zig.Server.Message.EmitBinPath
                        resolve({
                            success: true,
                            path: data.subarray(1).toString("utf8"),
                        });
                        return;
                    }
                    default:
                        reject(new Error(`received unexpected message tag ${tag.toString()}`));
                        childProcess.kill();
                        return;
                }
            }
        });

        childProcess.stderr?.on("data", (stderr: string) => {
            // remove this once Zig reports progress through the ZCS interface instead of stderr
            options.onProgress(stderr);
        });
    });
}
