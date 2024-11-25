#!/usr/bin/env node

import PIA from "./lib.js";
import App from "./app.js";
const oldlog = console.log.bind(console)
console.log = function (...args) {
    oldlog('[' + (new Date()).toLocaleTimeString() + ']: ', ...args)
}

if (!process.env.PIA_USERNAME || process.env.PIA_USERNAME === '') throw new Error("Missing PIA_USERNAME environment variable")
if (!process.env.PIA_PASSWORD || process.env.PIA_PASSWORD === '') throw new Error("Missing PIA_PASSWORD environment variable")
await (async ()=> {
    const keys = await PIA.GenKeys()
    let pia = new PIA(process.env.PIA_USERNAME, process.env.PIA_PASSWORD, keys, process.env.PIA_DIP)
    pia.iptables = App.iptables
    let app = new App()

    app.on('stopped', async ()=>{
        console.log("Restarting App due to exit")
        setTimeout(()=>app.start(), 5000)
    })

    const loop = async () => {
        console.log("Starting loop...")
        pia.once('pf_connected', (port)=>{
            app.connected = true
            app.port = port
            app.start()

            pia.once('disconnected', ()=>{
                console.log('Disconnection detected. Looping...')
                app.connected = false
                app.stop()
                loop()
            })
        })
        await pia.connect()
    }

    await loop()
})()