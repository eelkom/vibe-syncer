import type { UserData } from '@/types/user';
import { createContext, useContext, useState } from 'react';

interface UserContextType {
  user: UserData | null;
  login: (data: UserData) => void;
}

const UserContext = createContext<UserContextType | null>(null);

export function UserContextProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<UserData | null>(() => {
    const saved = sessionStorage.getItem('user');
    return saved ? JSON.parse(saved) : null;
  });

  const login = (data: UserData) => {
    setUser(data);
    sessionStorage.setItem('user', JSON.stringify(data));
  };

  return (
    <UserContext.Provider value={{ user, login }}>
      {children}
    </UserContext.Provider>
  );
}

export const useUser = () => {
  const context = useContext(UserContext);
  if (!context) throw new Error('useUser error');
  return context;
};
