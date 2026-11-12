import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const PrintPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [container, setContainer] = useState<HTMLDivElement | null>(null);

    useEffect(() => {
        const div = document.createElement('div');
        div.id = 'print-root';
        document.body.appendChild(div);
        setContainer(div);

        return () => {
            document.body.removeChild(div);
        };
    }, []);

    if (!container) return null;

    return createPortal(children, container);
};
