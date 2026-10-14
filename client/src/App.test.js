import { render, screen } from '@testing-library/react';
import App from './App';

jest.mock('socket.io-client', () => ({
  io: () => ({ on() {}, off() {}, emit() {}, connect() {}, disconnect() {} }),
}), { virtual: true });

beforeEach(() => localStorage.clear());

test('shows the login screen when there is no saved session', () => {
  render(<App />);
  expect(screen.getAllByText(/login/i).length).toBeGreaterThan(0);
});
