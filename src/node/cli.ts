import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import { setUnexpectedErrorHandler } from "vs/base/common/errors";
import { main as vsCli } from "vs/code/node/cliProcessMain";
import { validatePaths } from "vs/code/node/paths";
import { ParsedArgs } from "vs/platform/environment/common/environment";
import { buildHelpMessage, buildVersionMessage, Option as VsOption, OPTIONS, OptionDescriptions } from "vs/platform/environment/node/argv";
import { parseMainProcessArgv } from "vs/platform/environment/node/argvHelper";
import product from "vs/platform/product/common/product";
import { ipcMain } from "vs/server/src/node/ipc";
import { enableCustomMarketplace } from "vs/server/src/node/marketplace";
import { MainServer } from "vs/server/src/node/server";
import { AuthType, buildAllowedMessage, enumToArray, FormatType, generateCertificate, generatePassword, localRequire, open, unpackExecutables } from "vs/server/src/node/util";

const { logger } = localRequire<typeof import("@coder/logger/out/index")>("@coder/logger/out/index");
setUnexpectedErrorHandler((error) => logger.warn(error.message));

interface Args extends ParsedArgs {
	auth?: AuthType;
	"base-path"?: string;
	cert?: string;
	"cert-key"?: string;
	format?: string;
	host?: string;
	open?: boolean;
	port?: string;
	socket?: string;
}

// @ts-ignore: Force `keyof Args` to work.
interface Option extends VsOption {
	id: keyof Args;
}

const getArgs = (): Args => {
	// Remove options that won't work or don't make sense.
	for (let key in OPTIONS) {
		switch (key) {
			case "add":
			case "diff":
			case "file-uri":
			case "folder-uri":
			case "goto":
			case "new-window":
			case "reuse-window":
			case "wait":
			case "disable-gpu":
			// TODO: pretty sure these don't work but not 100%.
			case "max-memory":
			case "prof-startup":
			case "inspect-extensions":
			case "inspect-brk-extensions":
				delete OPTIONS[key];
				break;
		}
	}

	const options = OPTIONS as OptionDescriptions<Required<Args>>;
	options["base-path"] = { type: "string", cat: "o", description: "Base path of the URL at which code-server is hosted (used for login redirects)." };
	options["cert"] = { type: "string", cat: "o", description: "Path to certificate. If the path is omitted, both this and --cert-key will be generated." };
	options["cert-key"] = { type: "string", cat: "o", description: "Path to the certificate's key if one was provided." };
	options["format"] = { type: "string", cat: "o", description: `Format for the version. ${buildAllowedMessage(FormatType)}.` };
	options["host"] = { type: "string", cat: "o", description: "Host for the server." };
	options["auth"] = { type: "string", cat: "o", description: `The type of authentication to use. ${buildAllowedMessage(AuthType)}.` };
	options["open"] = { type: "boolean", cat: "o", description: "Open in the browser on startup." };
	options["port"] = { type: "string", cat: "o", description: "Port for the main server." };
	options["socket"] = { type: "string", cat: "o", description: "Listen on a socket instead of host:port." };

	const args = parseMainProcessArgv(process.argv);
	if (!args["user-data-dir"]) {
		args["user-data-dir"] = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "code-server");
	}
	if (!args["extensions-dir"]) {
		args["extensions-dir"] = path.join(args["user-data-dir"], "extensions");
	}

	if (!args.verbose && !args.log && process.env.LOG_LEVEL) {
		args.log = process.env.LOG_LEVEL;
	}

	return validatePaths(args);
};

const startVscode = async (): Promise<void | void[]> => {
	const args = getArgs();
	const extra = args["_"] || [];
	const options = {
		auth: args.auth || AuthType.Password,
		basePath: args["base-path"],
		cert: args.cert,
		certKey: args["cert-key"],
		folderUri: extra.length > 1 ? extra[extra.length - 1] : undefined,
		host: args.host,
		password: process.env.PASSWORD,
	};

	if (enumToArray(AuthType).filter((t) => t === options.auth).length === 0) {
		throw new Error(`'${options.auth}' is not a valid authentication type.`);
	} else if (options.auth === "password" && !options.password) {
		options.password = await generatePassword();
	}

	if (!options.certKey && typeof options.certKey !== "undefined") {
		throw new Error(`--cert-key cannot be blank`);
	} else if (options.certKey && !options.cert) {
		throw new Error(`--cert-key was provided but --cert was not`);
	} if (!options.cert && typeof options.cert !== "undefined") {
		const { cert, certKey } = await generateCertificate();
		options.cert = cert;
		options.certKey = certKey;
	}

	enableCustomMarketplace();

	const server = new MainServer({
		...options,
		port: typeof args.port !== "undefined" ? parseInt(args.port, 10) : 8080,
		socket: args.socket,
	}, args);

	const [serverAddress, /* ignore */] = await Promise.all([
		server.listen(),
		unpackExecutables(),
	]);
	logger.info(`Server listening on ${serverAddress}`);

	if (options.auth === "password" && !process.env.PASSWORD) {
		logger.info(`  - Password is ${options.password}`);
		logger.info("    - To use your own password, set the PASSWORD environment variable");
		if (!args.auth) {
			logger.info("    - To disable use `--auth none`");
		}
	} else if (options.auth === "password") {
		logger.info("  - Using custom password for authentication");
	} else {
		logger.info("  - No authentication");
	}

	if (server.protocol === "https") {
		logger.info(
			args.cert
				? `  - Using provided certificate${args["cert-key"] ? " and key" : ""} for HTTPS`
				: `  - Using generated certificate and key for HTTPS`,
		);
	} else {
		logger.info("  - Not serving HTTPS");
	}

	if (!server.options.socket && args.open) {
		// The web socket doesn't seem to work if browsing with 0.0.0.0.
		const openAddress = serverAddress.replace(/:\/\/0.0.0.0/, "://localhost");
		await open(openAddress).catch(console.error);
		logger.info(`  - Opened ${openAddress}`);
	}
};

const startCli = (): boolean | Promise<void> => {
	const args = getArgs();
	if (args.help) {
		const executable = `${product.applicationName}${os.platform() === "win32" ? ".exe" : ""}`;
		console.log(buildHelpMessage(product.nameLong, executable, product.codeServerVersion, OPTIONS, false));
		return true;
	}

	if (args.version) {
		if (args.format === "json") {
			console.log(JSON.stringify({
				codeServerVersion: product.codeServerVersion,
				commit: product.commit,
				vscodeVersion: product.version,
			}));
		} else {
			buildVersionMessage(product.codeServerVersion, product.commit).split("\n").map((line) => logger.info(line));
		}
		return true;
	}

	const shouldSpawnCliProcess = (): boolean => {
		return !!args["install-source"]
			|| !!args["list-extensions"]
			|| !!args["install-extension"]
			|| !!args["uninstall-extension"]
			|| !!args["locate-extension"]
			|| !!args["telemetry"];
	};

	if (shouldSpawnCliProcess()) {
		enableCustomMarketplace();
		return vsCli(args);
	}

	return false;
};

export class WrapperProcess {
	private process?: cp.ChildProcess;
	private started?: Promise<void>;

	public constructor() {
		ipcMain.onMessage(async (message) => {
			switch (message) {
				case "relaunch":
					logger.info("Relaunching...");
					this.started = undefined;
					if (this.process) {
						this.process.kill();
					}
					try {
						await this.start();
					} catch (error) {
						logger.error(error.message);
						process.exit(typeof error.code === "number" ? error.code : 1);
					}
					break;
				default:
					logger.error(`Unrecognized message ${message}`);
					break;
			}
		});
	}

	public start(): Promise<void> {
		if (!this.started) {
			const child = this.spawn();
			this.started = ipcMain.handshake(child);
			this.process = child;
		}
		return this.started;
	}

	private spawn(): cp.ChildProcess {
		return cp.spawn(process.argv[0], process.argv.slice(1), {
			env: {
				...process.env,
				LAUNCH_VSCODE: "true",
			},
			stdio: ["inherit", "inherit", "inherit", "ipc"],
		});
	}
}

const main = async(): Promise<boolean | void | void[]> => {
	if (process.env.LAUNCH_VSCODE) {
		await ipcMain.handshake();
		return startVscode();
	}
	return startCli() || new WrapperProcess().start();
};

const exit = process.exit;
process.exit = function (code?: number) {
	const err = new Error(`process.exit() was prevented: ${code || "unknown code"}.`);
	console.warn(err.stack);
} as (code?: number) => never;

// It's possible that the pipe has closed (for example if you run code-server
// --version | head -1). Assume that means we're done.
if (!process.stdout.isTTY) {
	process.stdout.on("error", () => exit());
}

main().catch((error) => {
	logger.error(error.message);
	exit(typeof error.code === "number" ? error.code : 1);
});
