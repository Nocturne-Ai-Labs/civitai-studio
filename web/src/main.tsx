import React from 'react'
import { createRoot } from 'react-dom/client'
import { Studio } from './studio'
import 'bulma/css/bulma.min.css'
import './styles.css'
import { applyAccentColor, readAccentColor } from './theme'

// Apply the saved accent before mounting any controls, including Radix portals.
applyAccentColor(readAccentColor())
createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Studio /></React.StrictMode>,
)
