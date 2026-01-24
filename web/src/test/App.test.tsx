import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import App from '../App'

describe('App', () => {
  it('renders without crashing', () => {
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>
    )
    // App should render the session list by default at "/"
    expect(document.querySelector('.app')).toBeInTheDocument()
  })

  it('renders header with title on home page', async () => {
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>
    )
    // The header with "Claude Roam" should be rendered
    expect(await screen.findByText('Claude Roam')).toBeInTheDocument()
  })
})
