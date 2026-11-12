import { Link } from 'react-router-dom'
import { GLOSSARY } from '../music/explain'

/** Route /help — the words the app uses, without music theory. */
export default function GlossaryPage() {
  return (
    <div className="page">
      <h1>Словарик</h1>
      <p className="muted">
        Всё, что нужно знать, чтобы заниматься, — без нот и сольфеджио. Начать проще всего с <Link to="/learn">аккордов и разминки</Link>.
      </p>
      <dl className="glossary">
        {GLOSSARY.map((g) => (
          <div key={g.id} id={g.id} className="glossary-item">
            <dt>{g.term}</dt>
            <dd>{g.text}</dd>
          </div>
        ))}
        <div id="roll" className="glossary-item">
          <dt>Лента нот (пиано-ролл)</dt>
          <dd>
            Каждая нота — полоска: где она стоит — какую клавишу нажать, длина — сколько держать. В DAW такой вид называется
            «пиано-ролл»; здесь он повёрнут, и ноты падают на клавиши. На паузе ленту можно листать колёсиком (или щёлкнуть по ней и
            листать стрелками ↑ ↓), а двойным щелчком по такту или протяжкой мышью — выбрать кусок, который хотите учить.
          </dd>
        </div>
      </dl>
    </div>
  )
}
