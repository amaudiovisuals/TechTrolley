import React from 'react';
import { CompanySettings } from '../types';

interface LogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  showText?: boolean;
  companySettings?: CompanySettings | null;
  variant?: 'login' | 'dashboard' | 'challan';
}

export const Logo: React.FC<LogoProps> = ({ className = '', size = 'md', showText = true, companySettings, variant = 'dashboard' }) => {
  const iconDimensions = {
    sm: 'w-16 h-12',
    md: 'w-32 h-24',
    lg: 'w-48 h-36'
  };

  const logoSrc = companySettings?.logo || '/logo.png';
  const poweredBy = (companySettings?.powered_by_name && companySettings.powered_by_name.trim()) || 'am audiovisuals';
  const poweredParts = poweredBy.split(' ');

  const getPoweredByColor = () => {
    if (variant === 'challan') return 'text-black font-black';
    if (variant === 'login') return 'text-sky-900 font-black';
    return 'text-white/50';
  };

  return (
    <div className={`flex flex-col items-start gap-1 ${className}`}>
      {/* Logo Image */}
      <div className={`${iconDimensions[size]} relative flex items-center justify-center`}>
        <img
          src={logoSrc}
          alt="Logo"
          className="w-full h-full object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).src = '/logo.png';
          }}
        />
      </div>

      {showText && (
        <div className="flex flex-col items-start">
          <h1 className={`font-black tracking-tighter uppercase leading-none ${size === 'lg' ? 'text-5xl' : 'text-3xl'} text-[#00AEEF]`}>
            TECH <span className="text-[#F15A24]">TROLLEY</span>
          </h1>
          <div className="flex flex-col items-end mt-0.5 self-end">
            <p className={`text-[10px] font-black lowercase tracking-[0.4em] leading-none whitespace-nowrap ${getPoweredByColor()}`}>
              powered by
            </p>
            <p className="text-sm font-bold mt-0.5 leading-none lowercase" style={{ fontFamily: 'Tahoma, sans-serif' }}>
              <span className="text-[#00AEEF]">am</span>
              <span className="text-[#F15A24]">audiovisuals</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
