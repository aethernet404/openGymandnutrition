// /nutrition/* — the whole feature behind one route, so App.jsx needs a single line for it.
import { Navigate, Route, Routes } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import Diary from './Diary.jsx'
import Foods from './Foods.jsx'
import Goals from './Goals.jsx'
import Health from './Health.jsx'

export default function Nutrition() {
  const user = useStore(s => s.user)
  // Nutrition lives on the server, so a guest (who never reaches it) has nothing to open.
  if (!user) return <Navigate to="/home" replace />
  return <Routes>
    <Route index element={<Diary />} />
    <Route path="foods" element={<Foods />} />
    <Route path="goals" element={<Goals />} />
    <Route path="health" element={<Health />} />
    <Route path="*" element={<Navigate to="/nutrition" replace />} />
  </Routes>
}
