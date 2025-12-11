import { appendFile } from "fs/promises"
import fs from "fs"
import { join } from "path"

const config = {
    debug: process.env.NODE_ENV === 'development',
    suffix: process.env.ENV_FILE?.replace('../', '') ?? '',
    screen: process.env.PRINT_SCREEN ?? false,  // Output to screen
}

const realStdoutFd = 1;
const realStderrFd = 2;

function procArgs(args: any[]) {
    return args.map(arg => {
        if (typeof arg === 'object') {
            return JSON.stringify(arg, null, 2)
        }
        return arg
    }).join(' ')
}
const realConsole = {
    log: (...args: any[]) => fs.writeSync(realStdoutFd, procArgs(args) + '\n'),
    error: (...args: any[]) => fs.writeSync(realStderrFd, procArgs(args) + '\n'),
    warn: (...args: any[]) => fs.writeSync(realStderrFd, procArgs(args) + '\n'),
    info: (...args: any[]) => fs.writeSync(realStdoutFd, procArgs(args) + '\n'),
    debug: (...args: any[]) => fs.writeSync(realStdoutFd, procArgs(args) + '\n'),
};

// 自定义颜色
const colors = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    grey: "\x1b[38;5;250m",
    white: "\x1b[37m",
    green: "\x1b[32m"
};

// 日志文件路径
const LOG_DIR = join(__dirname, "../../logs");

// 获取当前日期的日志文件名
function getLogFilePath(level: string) {
    if (['ERROR', 'WARN'].includes(level.toUpperCase())) {
        return join(LOG_DIR, `err-${new Date().toISOString().split('T')[0]}-${config.suffix}.log`);
    } else {
        return join(LOG_DIR, `log-${new Date().toISOString().split('T')[0]}-${config.suffix}.log`);
    }
}

// 确保日志目录存在
function ensureLogDir() {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch (err) {
        realConsole.error("Failed to create log directory:", err);
    }
}
ensureLogDir()


function convertToString(args: any[]) {
    return args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(" ");
}

// 异步写入日志文件
async function writeToFile(level: string, message: string) {
    const logMessage = `${new Date().toISOString()} [${level}] ${(typeof message === 'object') ? JSON.stringify(message, null, 2) : message}\n`;
    const logFile = getLogFilePath(level);
    try {
        await appendFile(logFile, logMessage, { flag: "a" });
    } catch (err) {
        fs.writeSync(realStderrFd, `[LOG WRITE FAIL] ${err}\n`);
    }
}

function getCurrentTimestamp(name: string): string {
    const now = new Date();
    return `[${now.toISOString()} ${name}]`; // YYYY-MM-DD HH:mm:ss
}

console.error = (...args) => {
    const callerFile = getCallFile();
    const message = convertToString(args);
    if (config.screen)
        realConsole.error(colors.red, callerFile, getCurrentTimestamp("ERROR"), ...args, colors.reset);
    writeToFile("ERROR", message).catch(err => realConsole.error("Failed to write to log file:", err));
};

console.warn = (...args) => {
    const callerFile = getCallFile();
    const message = convertToString(args);
    if (config.screen)
        realConsole.warn(colors.yellow, callerFile, getCurrentTimestamp("WARN"), ...args, colors.reset);
    writeToFile("WARN", message).catch(err => realConsole.error("Failed to write to log file:", err));
};

console.info = (...args) => {
    const callerFile = getCallFile();
    if (config.screen)
        realConsole.info(colors.green, callerFile, getCurrentTimestamp("INFO"), ...args, colors.reset);
    const message = convertToString(args);
    writeToFile("INFO", message).catch(err => realConsole.error("Failed to write to log file:", err));
};

console.debug = (...args) => {
    const callerFile = getCallFile();
    if (config.debug) {
        if (config.screen)
            realConsole.debug(colors.cyan, callerFile, getCurrentTimestamp("DEBUG"), ...args, colors.reset);
        const message = convertToString(args);
        writeToFile("DEBUG", message).catch(err => realConsole.error("Failed to write to log file:", err));
    }
}

console.log = (...args) => {
    const callerFile = getCallFile();
    if (config.debug) {
        if (config.screen)
            realConsole.log(colors.grey, callerFile, getCurrentTimestamp("LOG"), ...args, colors.reset);
        const message = convertToString(args);
        writeToFile("LOG", message).catch(err => realConsole.error("Failed to write to log file:", err));
    }
}

function getCallFile() {
    const err = new Error();
    let callerFile = '';

    // 使用 V8 stack trace API 获取调用栈对象
    const origPrepareStackTrace = (Error as any).prepareStackTrace;
    (Error as any).prepareStackTrace = (_: any, stackFrames: NodeJS.CallSite[]) => stackFrames;
    const stackFrames = err.stack as unknown as NodeJS.CallSite[];
    (Error as any).prepareStackTrace = origPrepareStackTrace;
    if (stackFrames && stackFrames.length >= 3) {
        // 第0行：Error
        // 第1行：console.info override
        // 第2行：真正的调用者
        const frame = stackFrames[2];
        callerFile = frame.getFileName()?.split('/').pop() || '';
        callerFile = `[${callerFile}]`;
    }
    return callerFile;
}