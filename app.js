import EventEmitter from "node:events";
import child_process from "node:child_process";

const UID = (process.env.SETUID !== "" && typeof process.env.SETUID === "string")  ? process.env.GID : undefined;
const GID = (process.env.SETGID !== "" && typeof process.env.SETGID === "string")  ? process.env.GID : undefined;

export default class App extends EventEmitter {
    static iptables = []
    constructor() {
        super();
        this.state = undefined
        this.connected = false
    }
    async start(port) {
        if (!this.connected) {
            console.log("Not Connected, not starting app")
        }
        if (this.state !== undefined) {
            return
        }
        let cp = child_process.spawn('true', [], {
            uid: UID,
            gid: GID,
        })

        const bufferClear = []
        function bufferedOutput(prefix) {
            let buffer = ''
            bufferClear.push(()=>console.log(prefix, buffer))
            return function (data) {
                buffer += data
                let buf = buffer.split('\n')
                while (buf.length > 0) {
                    console.log(prefix, buf.shift())
                }
                buffer = buf.join('\n')
            }
        }
        cp.stdout.on('data', bufferedOutput('[APP STD]:'))
        cp.stderr.on('data', bufferedOutput('[APP ERR]:'))

        cp.on("close", code => {
            while (bufferClear.pop()()) {}
            this.cleanup()
        })

        this.state = {
            cp
        }
        this.emit('started')
    }

    cleanup() {
        this.state.cp.kill()
        this.state = undefined
        this.emit('stopped')
    }

    async stop() {
        this.state.cp.kill()
    }
}