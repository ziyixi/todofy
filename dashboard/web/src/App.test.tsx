import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('scaffold', () => {
  it('renders the page title', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: '运维面板' })).toBeInTheDocument()
  })
})
