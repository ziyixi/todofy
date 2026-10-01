/** The UI's entry: styles, then the app (app.ts) mounted on #app. */
import './styles.css'
import { mountApp } from './app.ts'

const root = document.getElementById('app')
if (root !== null) void mountApp(root)
