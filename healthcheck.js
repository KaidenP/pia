#!/usr/bin/env node
import {exec} from "./lib.js"

export async function healthcheck() {
    try {
        await exec('ping', ['-c', '1', '8.8.8.8'])
    } catch (error) {
        console.log('Healthcheck Failed')
        return 1
    }
    console.log('Healthcheck Passed')
    return 0
}

if (require.main === module) {
    healthcheck().then(code=>process.exit(code));
}