#!/usr/bin/env node
const {exec} = import("./lib.js")

module.exports = {
    healthcheck: async ()=> {
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