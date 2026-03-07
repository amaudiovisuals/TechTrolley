import React from 'react';
import { CompanySettings } from '../types';

interface LogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  showText?: boolean;
  companySettings?: CompanySettings | null;
}

export const Logo: React.FC<LogoProps> = ({ className = '', size = 'md', showText = true, companySettings }) => {
  const iconDimensions = {
    sm: 'w-16 h-12',
    md: 'w-32 h-24',
    lg: 'w-48 h-36'
  };

  const logoSrc = companySettings?.logo || '/logo.png';
  const poweredBy = companySettings?.powered_by_name || 'a m audiovisuals';
  const poweredParts = poweredBy.split(' ');

  return (
    <div className={`flex flex-col items-start gap-2 ${className}`}>
      {/* Exact SVG Reconstruction with Glow for Night Mode */}
      <div className={`${iconDimensions[size]} relative flex items-center justify-center`}>
        <img
          src={logoSrc}
          alt="Tech Trolley Logo"
          className="w-full h-full object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).src = '/logo.png';
          }}
        />
      </div>

      {showText && (
        <div className="flex flex-col">
          <h1 className={`font-black tracking-tighter uppercase leading-none ${size === 'lg' ? 'text-5xl' : 'text-3xl'} text-[#00AEEF]`}>
            TECH <span className="text-[#F15A24]">TROLLEY</span>
          </h1>
          <div className="flex flex-col mt-3">
            <div className="flex items-center gap-2">
              <span className="h-[2px] w-8 bg-white/20"></span>
              <p className="text-[9px] font-black text-white/40 lowercase tracking-[0.3em] leading-none whitespace-nowrap">
                powered by
              </p>
            </div>
            <p className="text-sm font-bold mt-1 ml-10 leading-none lowercase" style={{ fontFamily: 'Tahoma, sans-serif' }}>
              <span className="text-[#F15A24]">{poweredParts.slice(0, -1).join(' ')}</span> <span className="text-[#00AEEF]">{poweredParts.slice(-1).join(' ')}</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
