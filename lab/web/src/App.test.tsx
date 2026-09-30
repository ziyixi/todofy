import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('renders the Chinese title', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: '论文雷达' })).toBeInTheDocument()
  })
})
