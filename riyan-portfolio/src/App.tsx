import { useEffect, useState } from 'react';
import './App.css';

function App() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div className="app">
      <header className={scrolled ? 'glass-panel border-b-0 m-4 rounded-full px-6 transition-all duration-300 py-3' : 'transition-all duration-300'}>
        <div className="container nav-container">
          <div className="logo font-black text-white">
            <span className="text-gradient">Riyan.</span>
          </div>
          <nav className="nav-links">
            <a href="#about">About</a>
            <a href="#work">Work</a>
            <a href="#contact">Contact</a>
          </nav>
        </div>
      </header>

      <main>
        {/* HERO SECTION */}
        <section className="hero container" id="about">
          <div className="hero-bg"></div>
          <div className="hero-content">
            <div className="hero-text animate-on-load">
              <span className="section-label">Frontend Engineer</span>
              <h1>Building <span className="text-gradient">Digital Experiences</span> That Matter.</h1>
              <p>Hi, I'm Riyan. I specialize in developing performant, premium web applications that blend visually stunning design with robust engineering.</p>
              <a href="#work" className="btn-primary mt-4">
                View My Work <i className="fa-solid fa-arrow-right"></i>
              </a>
            </div>
            
            <div className="hero-visual animate-on-load delay-200">
              <div className="profile-image-wrapper">
                <img src="/profile.png" alt="Riyan" className="profile-image" />
              </div>
            </div>
          </div>
        </section>

        {/* FEATURED WORK */}
        <section className="projects container" id="work">
          <span className="section-label animate-on-load delay-100">Featured Work</span>
          <h2 className="section-title animate-on-load delay-200">Case Studies</h2>
          
          <div className="project-card glass-panel animate-on-load delay-300">
            <div className="project-info">
              <h3 className="text-gradient">Tech Trolley</h3>
              <p>An enterprise-grade, ultra-responsive web application designed to manage and track AV & IT assets for large-scale medical and technical conferences. Features role-based access control, barcode scanning flows, and real-time inventory tracking.</p>
              
              <div className="tech-stack">
                <span className="tech-tag">React</span>
                <span className="tech-tag">TypeScript</span>
                <span className="tech-tag">Vite</span>
                <span className="tech-tag">Tailwind CSS</span>
                <span className="tech-tag">Django API</span>
              </div>
              
            </div>
            
            <div className="project-visual">
              <div className="project-image-wrapper">
                <img src="/project1.png" alt="Tech Trolley Dashboard" className="project-image" />
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer id="contact" className="animate-on-load delay-300">
        <div className="container">
          <h2 className="text-2xl font-bold mb-4 text-white">Let's Build Something Great</h2>
          <p className="mb-8">RIYAN@AMAUDIOVISUALS.COM</p>
          <p>&copy; {new Date().getFullYear()} Riyan. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

export default App;
