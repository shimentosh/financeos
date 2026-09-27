import type { ReactNode } from "react";
import { SiteSection } from "@/components/marketing/site-chrome";

export type LegalSection = { id: string; title: string; body: ReactNode };

/** A long-form legal document: title, date, a table of contents and numbered sections. */
export function LegalPage({ title, updated, intro, sections }: { title: string; updated: string; intro: ReactNode; sections: LegalSection[] }) {
  return (
    <SiteSection className="py-14 md:py-20">
      <div className="grid gap-10 lg:grid-cols-[14rem_1fr]">
        <nav aria-label="Contents" className="hidden lg:block">
          <div className="sticky top-20 space-y-1 text-sm">
            <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Contents</p>
            {sections.map((section, index) => (
              <a key={section.id} href={`#${section.id}`} className="block text-muted-foreground transition-colors hover:text-foreground">
                {index + 1}. {section.title}
              </a>
            ))}
          </div>
        </nav>
        <article className="max-w-3xl">
          <h1 className="font-semibold text-3xl tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">Last updated {updated}</p>
          <div className="mt-6 space-y-3 text-[15px] leading-relaxed text-foreground/90">{intro}</div>
          {sections.map((section, index) => (
            <section key={section.id} id={section.id} className="mt-10 scroll-mt-20">
              <h2 className="font-semibold text-lg">
                {index + 1}. {section.title}
              </h2>
              <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-foreground/90 [&_li]:ms-5 [&_li]:list-disc [&_li]:ps-1 [&_ul]:space-y-1.5">
                {section.body}
              </div>
            </section>
          ))}
        </article>
      </div>
    </SiteSection>
  );
}
