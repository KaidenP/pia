import got from 'got'
import child_process from "node:child_process";
import fs from "node:fs/promises";
import {healthcheck} from "./healthcheck.cjs";
import EventEmitter from 'node:events'

function exec(cmd, args, stdin) {
    return new Promise((resolve, reject) => {
        const child = child_process.spawn(cmd, args)

        let stdout = ''
        let stderr = ''

        child.stdout.on('data', (chunk) => {
            stdout += chunk
            stderr += chunk
        })

        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })

        if (!!stdin) {
            child.stdin.end(stdin)
        }

        child.on("close", code => {
            if (code === 0) {
                resolve({code, stdout, stderr})
            } else {
                console.log("Exec failed: ", cmd, ...args)
                reject({code, stdout, stderr})
            }
        })

        child.on("exit", code => {
            child.kill()
        })
    })
}

class PIA extends EventEmitter {
    constructor(username, password, keys, DIP_TOKEN) {
        super()
        if (!username || !password) {
            throw new Error("Missing username or password")
        }
        this.username = username
        this.password = password
        this.keys = keys
        this.DIP_TOKEN = DIP_TOKEN

        this.active = false
        this.iptables = []
    }

    static async GenKeys() {
        let privkey = (await exec('wg', ['genkey'])).stdout
        let pubkey = (await exec('wg', ['pubkey'], privkey)).stdout
        return {
            privkey, pubkey
        }
    }

    async setupIptables() {
        console.log("Configuring iptables...")
        try {
            await exec('ip6tables', ['-P', 'INPUT', 'DROP'])
            await exec('ip6tables', ['-P', 'OUTPUT', 'DROP'])
            await exec('ip6tables', ['-P', 'FORWARD', 'DROP'])
        } catch (e) {
            console.log("Setting ip6tables failed: ", e)
        }

        await exec('iptables', ['-P', 'INPUT', 'DROP'])
        await exec('iptables', ['-P', 'OUTPUT', 'DROP'])
        await exec('iptables', ['-P', 'FORWARD', 'DROP'])
        await exec('iptables', ['-A', 'INPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'])
        await exec('iptables', ['-A', 'OUTPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'])
        await exec('iptables', ['-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT'])
        await exec('iptables', ['-A', 'INPUT', '-i', 'lo', '-j', 'ACCEPT'])
        await exec('iptables', ['-A', 'OUTPUT', '-o', 'pia', '-j', 'ACCEPT'])
        // await exec('iptables', ['-A', 'INPUT', '-p', 'tcp', '-i', 'eth0', '--dport', '8080', '-j', 'ACCEPT'])
        console.log('Configuring iptables extra app rules...')
        for (let i = 0; i < this.iptables.length; i++) {
            await exec('iptables', this.iptables[i])
        }
        console.log("Done!")
    }

    static async ClearIptables() {
        console.log("Clearing iptables...")
        try {
            await exec('ip6tables', ['-F'])
        } catch (e) {console.log("Setting ip6tables failed: ", e)}
        await exec('iptables', ['-F'])
        console.log("Done!")
    }

    async connect() {
        console.log("PIA: Getting token...")
        const loginData = new FormData()
        loginData.append('username', this.username)
        loginData.append('password', this.password)
        const {token} = await got.post('https://www.privateinternetaccess.com/api/client/v2/token', {
            body: loginData
        }).json()
        console.log(`Got token : ${token.substring(0, 5)}*****`)

        let conn_data = {}
        if (!!this.DIP_TOKEN) {
            console.log("Registering DIP_TOKEN")
            let DIP = (await got.post('https://www.privateinternetaccess.com/api/client/v2/dedicated_ip', {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Token ${token}`
                },
                body: JSON.stringify({tokens: [this.DIP_TOKEN]})
            }).json())[0]

            if (DIP.status !== 'active') throw new Error(`Got bad response: ${JSON.stringify(DIP)}`)
            conn_data = {
                ip: DIP.ip,
                cn: DIP.cn,
                dip_token: DIP.dip_token,
            }
        } else {
            throw new Error("PIA without DIP unimplemented")
        }

        console.log('Registering keys with PIA API...')
        let pia_json
        if (conn_data.dip_token) {
            pia_json = await got.get(`https://${conn_data.ip}:1337/addKey?${(new URLSearchParams({
                pubkey: this.keys.pubkey
            })).toString()}`, {
                headers: {
                    Host: conn_data.cn
                },
                https: {
                    certificateAuthority: await fs.readFile('ca.rsa.4096.crt')
                },
                username: `dedicated_ip_${conn_data.dip_token}`,
                password: conn_data.ip
            }).json()
        } else {
            throw new Error("PIA without DIP unimplemented: #2")
        }
        if (pia_json.status !== 'OK') throw new Error("PIA server did not return OK.")

        console.log(`Initializing connection settings...`)
        await exec('iptables', ['-A', 'OUTPUT', '-p', 'udp', '--dport', pia_json.server_port, '-d', conn_data.ip, '-o', 'eth0', '-j', 'ACCEPT'])
        await fs.writeFile('/etc/wireguard/pia.conf', `[Interface]
Address = ${pia_json.peer_ip}
PrivateKey = ${this.keys.privkey}
DNS = ${pia_json.dns_servers[0]}
PostUp = ip rule add from $(ip a show dev eth0 | grep 'inet ' | awk '{ print $2; }' | sed -r 's@/[0-9]+$@@') table main
PostUp = iptables -I OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -m conntrack ! --ctstate ESTABLISHED,RELATED -j REJECT
PreDown = ip rule del from $(ip a show dev eth0 | grep 'inet ' | awk '{ print $2; }' | sed -r 's@/[0-9]+$@@') table main
PreDown = iptables -D OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -m conntrack ! --ctstate ESTABLISHED,RELATED -j REJECT
[Peer]
PersistentKeepalive = 25
PublicKey = ${pia_json.server_key}
AllowedIPs = 0.0.0.0/0
Endpoint = ${conn_data.ip}:${pia_json.server_port}
`)
        console.log(`Starting VPN...`)
        await this.setupIptables()
        console.log(`wg-quick output:\n${(await exec('wg-quick', ['up', 'pia'])).stderr}`.split('\n').join('\n\t---->  '))
        console.log(`Done!`)

        this.state = {
            conn_data, pia_json, token
        }

        this.active = true
        setTimeout(()=>this.healthcheck(), 1000)
        this.emit('connected')
    }

    async port_forward() {
        console.log(`Setup Port Forwarding @${this.state.conn_data.ip}...`)
        let pf_json = await got.get(`https://${this.state.conn_data.ip}:19999/getSignature?${(new URLSearchParams({
            token: this.state.token
        })).toString()}`, {
            headers: {
                Host: this.state.conn_data.cn
            },
            https: {
                certificateAuthority: await fs.readFile('ca.rsa.4096.crt')
            }
        }).json()
        if (pf_json.status !== 'OK') throw new Error('Error Registering Port')
        let payload = JSON.parse(atob(pf_json.payload))

        console.log(`We got port ${payload.port}`)
        this.state.pf_port = payload.port
        this.emit('pf_connected', payload.port)

        await exec('iptables', ['-A', 'INPUT', '-p', 'udp', '-i', 'pia', '--dport', payload.port, '-j', 'ACCEPT'])
        await exec('iptables', ['-A', 'INPUT', '-p', 'tcp', '-i', 'pia', '--dport', payload.port, '-j', 'ACCEPT'])

        let pf_loop = async () => {
            if (!this.active) {
                console.log(`Cancelling PF loop; no longer connected to VPN...`)
                return
            }
            let pf_res = await got.get(`https://${this.state.conn_data.ip}:19999/bindPort?${(new URLSearchParams({
                signature: pf_json.signature,
                payload: pf_json.payload
            })).toString()}`, {
                headers: {
                    Host: hostname
                },
                https: {
                    certificateAuthority: await fs.readFile('ca.rsa.4096.crt')
                }
            }).json()
            if (pf_res.status !== 'OK') {
                //throw new Error('Port Refresh Failed')
                console.log(`Port Refresh Failed`)
                await this.disconnect()
                return
            }
            console.log("Done!")

            setTimeout(pf_loop, 15*60*1000)
        }

        await pf_loop()
    }

    async disconnect() {
        console.log(`Disconnecting...`)
        this.active = false
        this.state = undefined
        console.log(`wg-quick output:\n${(await exec('wg-quick', ['down', 'pia'])).stderr}`.split('\n').join('\n\t---->  '))
        await PIA.ClearIptables()
        this.emit('disconnected')
    }

    async healthcheck() {
        if (!this.active) return

        if (await healthcheck() === 0) {
            setTimeout(()=>this.healthcheck(), 1000*60*5)
            return
        }

        // Failed healthcheck
        await this.disconnect()
    }
}


export default PIA
export {exec}