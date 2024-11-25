#!/usr/bin/env node
let exec
module.exports = {
    healthcheck: async ()=> {
        exec = exec || (await import("./lib.js")).exec
        try {
            await exec('ping', ['-c', '1', '8.8.8.8'])
        } catch (error) {
            console.log('Healthcheck Failed')
            return 1
        }
        console.log('Healthcheck Passed')
        return 0
    }
}

if (require.main === module) {
    module.exports.healthcheck().then(code=>process.exit(code))
}