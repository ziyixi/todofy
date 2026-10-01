/** The launcher's entry: styles, then the page (view.ts) mounted on #app. */
import './styles.css'
import { mountLauncher } from './view.ts'

const root = document.getElementById('app')
if (root !== null) void mountLauncher(root)
