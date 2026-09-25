import { BrowserRouter, Routes, Route } from 'react-router-dom';
import LoginPage from './components/LoginPage';
import Dashboard from './components/Dashboard';
import ChatComponent from './components/ChatComponent';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/Dashboard" element={<Dashboard />} />
        <Route path="/ChatComponent" element={<ChatComponent />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;