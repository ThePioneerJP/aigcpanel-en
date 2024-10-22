import {defineStore} from "pinia"
import store from "../index";
import {EnumServerStatus, EnumServerType, ServerRecord, ServerRuntime} from "../../types/Server";
import {computed, ref, toRaw} from "vue";
import {cloneDeep} from "lodash-es";
import {ComputedRef} from "@vue/reactivity";
import {TimeUtil} from "../../lib/util";


const serverRuntime = ref<Map<string, ServerRuntime>>(new Map())
const createServerStatus = (record: ServerRecord): ComputedRef<EnumServerStatus> => {
    const key = `${record.name}-${record.version}`
    return computed(() => {
        return serverRuntime.value?.get(key)?.status || EnumServerStatus.STOPPED
    })
}
const createServerRuntime = (record: ServerRecord): ComputedRef<ServerRuntime> => {
    const key = `${record.name}-${record.version}`
    return computed(() => {
        return serverRuntime.value?.get(key) || {
            status: EnumServerStatus.STOPPED,
        } as ServerRuntime
    })
}
const getServerRuntime = (record: ServerRecord): ServerRuntime => {
    const key = `${record.name}-${record.version}`
    const value = serverRuntime.value?.get(key)
    if (value) {
        return value
    }
    serverRuntime.value?.set(key, {
        status: EnumServerStatus.STOPPED,
    } as ServerRuntime)
    return serverRuntime.value?.get(key) as ServerRuntime
}
const deleteServerRuntime = (record: ServerRecord) => {
    const key = `${record.name}-${record.version}`
    serverRuntime.value?.delete(key)
}

export const serverStore = defineStore("server", {
    state: () => ({
        records: [] as ServerRecord[],
    }),
    actions: {
        async init() {
            await window.$mapi.storage.get("server", "records", [])
                .then((records) => {
                    records.forEach((record: ServerRecord) => {
                        record.status = createServerStatus(record)
                        record.runtime = createServerRuntime(record)
                    })
                    this.records = records
                })
            await this.refresh()
        },
        async refresh() {
            const dirs = await window.$mapi.file.list('model')
            const localRecords: ServerRecord[] = []
            for (let dir of dirs) {
                const config = await window.$mapi.file.read(`model/${dir.name}/config.json`)
                let json
                try {
                    json = JSON.parse(config)
                } catch (e) {
                    continue
                }
                if (!json) {
                    continue
                }
                localRecords.push({
                    key: `${json.name}|${json.version}`,
                    name: json.name || dir.name,
                    title: json.title || dir.name,
                    version: json.version || '1.0.0',
                    type: EnumServerType.LOCAL,
                    functions: json.functions || [],
                    localPath: `model/${dir.name}`,
                    settings: json.settings || [],
                    setting: json.setting || {},
                } as ServerRecord)
            }
            let changed = false
            for (let lr of localRecords) {
                const record = this.records.find((record) => record.name === lr.name)
                if (!record) {
                    lr.status = createServerStatus(lr)
                    lr.runtime = createServerRuntime(lr)
                    this.records.unshift(lr as any)
                    changed = true
                } else {
                    if (!record.settings && lr.settings) {
                        record.settings = lr.settings
                        changed = true
                    }
                }
            }
            if (changed) {
                await this.sync()
            }
        },
        async start(server: ServerRecord) {
            const record = this.records.find((record) => record.name === server.name)
            if (record?.status === EnumServerStatus.STOPPED || record?.status === EnumServerStatus.ERROR) {
            } else {
                throw new Error('StatusError')
            }
            const serverRuntime = getServerRuntime(server)
            serverRuntime.status = EnumServerStatus.STARTING
            serverRuntime.startTimestampMS = TimeUtil.timestampMS()
            serverRuntime.logFile = `logs/${server.name}_${server.version}_${TimeUtil.dateString()}_${serverRuntime.startTimestampMS}.log`
            const eventChannel = await window.$mapi.event.channelCreate(function (channelData) {
                const {type, data} = channelData
                switch (type) {
                    case 'success':
                        clearTimeout(serverRuntime.pingCheckTimer)
                        serverRuntime.status = EnumServerStatus.STOPPED
                        window.$mapi.event.channelDestroy(eventChannel).then()
                        break
                    case 'error':
                        clearTimeout(serverRuntime.pingCheckTimer)
                        serverRuntime.status = EnumServerStatus.ERROR
                        window.$mapi.event.channelDestroy(eventChannel).then()
                        break
                    case 'starting':
                        break
                    default:
                        console.log('eventChannel', type, data)
                        break
                }
            })
            const serverInfo = {
                localPath: await window.$mapi.file.fullPath(server.localPath as string),
                name: record.name,
                version: record.version,
                setting: toRaw(record.setting),
                logFile: serverRuntime.logFile,
                eventChannelName: eventChannel
            }
            await window.$mapi.server.start(serverInfo)
            let pingTimeout = 60 * 5 * 1000
            let pingStart = TimeUtil.timestampMS()
            const pingCheck = () => {
                const now = TimeUtil.timestampMS()
                if (now - pingStart > pingTimeout) {
                    // console.log('ping.timeout')
                    serverRuntime.status = EnumServerStatus.ERROR
                    window.$mapi.server.stop(serverInfo)
                    return
                }
                window.$mapi.server.ping(serverInfo)
                    .then(success => {
                        if (success) {
                            serverRuntime.status = EnumServerStatus.RUNNING
                        } else {
                            serverRuntime.pingCheckTimer = setTimeout(pingCheck, 5000)
                        }
                    })
                    .catch(err => {
                        serverRuntime.pingCheckTimer = setTimeout(pingCheck, 5000)
                    })
            }
            serverRuntime.pingCheckTimer = setTimeout(pingCheck, 10 * 1000)
        },
        async stop(server: ServerRecord) {
            const record = this.records.find((record) => record.name === server.name)
            if (record?.status === EnumServerStatus.RUNNING) {
            } else {
                throw new Error('StatusError')
            }
            const serverRuntime = getServerRuntime(server)
            serverRuntime.status = EnumServerStatus.STOPPING
            const serverInfo = {
                localPath: await window.$mapi.file.fullPath(server.localPath as string),
                name: record.name,
                version: record.version,
                setting: toRaw(record.setting),
                logFile: serverRuntime.logFile,
            }
            await window.$mapi.server.stop(serverInfo)
        },
        async updateSetting(key: string, setting: any) {
            const record = this.records.find((record) => record.key === key)
            if (!record) {
                return
            }
            record.setting = Object.assign(record.setting || {}, setting)
            await this.sync()
        },
        async delete(server: ServerRecord) {
            const index = this.records.findIndex((record) => record.name === server.name)
            if (index === -1) {
                return
            }
            const record = this.records[index]
            if (record.status === EnumServerStatus.STOPPED
                || record.status === EnumServerStatus.ERROR) {
            } else {
                throw new Error('StatusError')
            }
            if (record.type === EnumServerType.LOCAL) {
                await window.$mapi.file.deletes(record.localPath as string)
            }
            this.records.splice(index, 1)
            deleteServerRuntime(server)
            await this.sync()
        },
        async sync() {
            const savedRecords = toRaw(cloneDeep(this.records))
            savedRecords.forEach((record) => {
                record.status = undefined
                record.runtime = undefined
            })
            await window.$mapi.storage.set("server", "records", savedRecords)
        },
        async getByKey(key: string): Promise<ServerRecord | undefined> {
            return this.records.find((record) => record.key === key)
        },
        async getByNameVersion(name: string, version: string): Promise<ServerRecord | undefined> {
            return this.records.find((record) => record.name === name && record.version === version)
        },
        async serverInfo(server: ServerRecord) {
            return {
                localPath: await window.$mapi.file.fullPath(server.localPath as string),
            }
        }
    }
})

const server = serverStore(store)
server.init().then(() => {
})

export const useServerStore = () => {
    return server
}
