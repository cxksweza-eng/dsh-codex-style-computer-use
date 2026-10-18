import path from 'node:path'
import { buildNativeBundle, workerReferences } from '../lib/core/native-runtime.js'
const root = path.resolve(import.meta.dirname, '..')
for (const spec of [
  { source: path.join(root, 'lib/core/worker.cs'), name: 'dsh-computer-use-worker.exe', references: workerReferences() },
  { source: path.join(root, 'lib/attention-worker.cs'), name: 'attention-worker.exe', references: ['System.Web.Extensions.dll'] },
]) console.log(JSON.stringify(buildNativeBundle(spec)))
