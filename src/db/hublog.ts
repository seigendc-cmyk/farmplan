import { SYNC_ORDER, type Db } from './database'

/** Makes sure every synced row has at least one entry in the Wi-Fi hub change feed (used on upgrade and whenever the hub starts). */
export function hubReindex(db: Db) {
  db.tx(() => {
    for (const t of SYNC_ORDER)
      db.run(`INSERT INTO hub_log(table_name,row_id) SELECT '${t}', id FROM ${t} WHERE id NOT IN (SELECT row_id FROM hub_log WHERE table_name='${t}')`)
  })
}
