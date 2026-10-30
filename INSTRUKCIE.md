# Inštrukcie pre sessions

Vlož do inštrukcií projektu. Server `claude-inbox` musí byť pripojený. Mená `chat`, `api` sú len príklady. English version: [INSTRUCTIONS.md](INSTRUCTIONS.md).

## Chat (orchestrátor)

```
Pošta (claude-inbox) je most medzi týmto chatom a Claude Code projektmi.
- Pred poslaním úlohy zavolaj `map(agent)`: karta, poznámky, otvorené vlákna a aktívne sessions.
  Nezadávaj úlohu, ktorá sa prekrýva s otvoreným vláknom.
- Úlohu pošli cez `send(to, subject, body, ticket?)`. Zadanie napíš samostatne
  (cieľ, súbory, čo je hotovo), druhá strana nevidí tento chat. Zapíš si thread_id.
- Doplňujúce otázky riešiš cez `reply(thread_id, body)`.
- Ráno a pri uzávierke zavolaj `map()` (stav všetkých projektov) a `inbox()`:
  správy s kind „summary“ prečítaj cez `read_thread` a zhrň, čo sa urobilo, commity a čo ostáva.
- Úlohy pre projekty s `wake` čakajú na schválenie používateľa. Nikdy ich neschvaľuj sám: keď používateľ povie „schváľ #7“, zavolaj `approve(thread_id)`; čakajúce ukáže `map()`.
- Kontext projektu opravuješ cez `context_write(agent, "card", text, section)`;
  sekcie: Čo to je, Aktuálny fokus, Rozhodnutia, Ďalší krok.
- Do repa nahliadneš cez `repo_read(agent, path)` (iba .md).
```

## Claude Code projekt

```
Pošta (claude-inbox): moja identita sa určí podľa repa (`claude-inbox whoami`). Ak status line alebo hook
hlásia novú poštu, pri vhodnej chvíli ju prečítaj. Keď napíšem „pošta“:
1. Zavolaj `inbox()`.
2. Pre každé vlákno `read_thread(thread_id)` a pracuj na úlohe.
3. Pri nejasnosti sa nedomýšľaj, opýtaj sa cez `reply(thread_id, body, kind="question")`
   a počkaj na odpoveď (znovu „pošta“).
4. Keď je hotovo, `close_thread(thread_id, summary, focus, next)`:
   - summary: čo sa urobilo, commity, čo ostáva,
   - focus: nový Aktuálny fokus projektu (1 až 3 riadky),
   - next: Ďalší krok.
```
