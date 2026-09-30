# Lingua Latina Study

**This project was vibe coded with Claude.**

A fast, minimal, portable Windows desktop app for studying Hans Ørberg's *Lingua Latina per Se Illustrata*: the reading book (*Familia Romana*) and the exercises book (*Exercitia Latina*) side by side.

![Screenshot](screenshot.png)

## Features

- Two resizable panes: Reading (left) and Exercises (right)
- Dark mode default, plus light and sepia themes
- Text highlights and notes on the reading pane
- Xournal++-style text boxes, pen, highlighter, and eraser on the exercises pane
- Searchable notes sidebar
- Export notes to Markdown
- All data stored locally in a portable `LatinData/` folder next to the `.exe`
- Rolling daily backups

## How to run

```bash
cd lingua-latina-study
npm install
npm start
```

## How to rebuild the portable .exe

```bash
npm install
npm run dist
```

The output will be in `build/LinguaLatinaStudy-1.0.0.exe`.

## License

MIT. See [LICENSE](./LICENSE).
