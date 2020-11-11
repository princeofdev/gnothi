import React, {useEffect, useState, useCallback} from "react";
import {SimplePopover, spinner} from "../utils";
import _ from "lodash";
import {
  Accordion,
  Button,
  Card,
  Form,
  Row,
  Col,
  ButtonGroup,
  Alert
} from "react-bootstrap";
import ReactStars from "react-stars";
import SetupHabitica from "./SetupHabitica";
import FieldModal from "./FieldModal";
import ChartModal from "./ChartModal";
import {FieldName} from "./utils";
import moment from 'moment'

import { useSelector, useDispatch } from 'react-redux'
import { fetch_, getFields } from '../redux/actions'
import './Fields.css'
import {FaChartLine, FaExclamationTriangle} from "react-icons/all";

const fmt = 'YYYY-MM-DD'
const iso = (day=null) => {
  const m = day ? moment(day) : moment()
  return m.format(fmt)
}

export default function Fields() {
  const [day, setDay] = useState(iso())
  const [fetchingSvc, setFetchingSvc] = useState(false)
  const [fieldEntries, setFieldEntries] = useState({})
  const [dupes, setDupes] = useState({})
  const [showForm, setShowForm] = useState(false)
  const [showChart, setShowChart] = useState(false)

  const dispatch = useDispatch()
  const as = useSelector(state => state.as)
  const user = useSelector(state => state.user)
  const fields = useSelector(state => state.fields)

  const isToday = iso() === iso(day)

  const fetchFieldEntries = async () => {
    if (_.isEmpty(fields)) {return}
    const {data} = await dispatch(fetch_(`field-entries?day=${day}`, 'GET'))
    const clean = {}
    const dupes = {}
    _.each(data, (fe) => {
      const k = fe.field_id
      if (clean[k]) {
        dupes[k].push(fe)
      } else {
        dupes[k] = [fe]
        clean[k] = fe.value
      }
    })
    setFieldEntries(clean)
    setDupes(dupes)
    // 3e896062: something about field_entries default_values?
  }

  useEffect(() => {
    fetchFieldEntries()
  }, [fields, day])

  // Update field-entries as they type / click, but not too fast; can cause race-condition in DB
  // https://www.freecodecamp.org/news/debounce-and-throttle-in-react-with-hooks/
  // TODO should I be using useRef instead of useCallback? (see link)
  const postFieldVal = useCallback(
    _.debounce((fid, value) => {
      if (value === "") {return}
      value = parseFloat(value) // until we support strings
      const body = {value}
      dispatch(fetch_(`field-entries/${fid}?day=${day}`, 'POST', body))
    }, 500),
    [] // will be created only once initially
  )

  if (_.get(fields, 'code') === 401) {
    return <h5>{fields.message}</h5>
  }

  const fetchService = async (service) => {
    setFetchingSvc(true)
    await dispatch(fetch_(`${service}/sync`, 'POST'))
    await dispatch(getFields())
    setFetchingSvc(false)
  }

  const changeFieldVal = (fid, direct=false) => e => {
    let value = direct ? e : e.target.value
    setFieldEntries({...fieldEntries, [fid]: value})
    postFieldVal(fid, value)
  }

  const changeCheck = fid => e => {
    changeFieldVal(fid, true)(~~!fieldEntries[fid])
  }

  const changeDay = dir => {
    if (dir === -1 ) {
      setDay(moment(day).subtract(1, 'day').format(fmt))
    } else {
      setDay(moment(day).add(1, 'day').format(fmt))
    }
  }

  const renderSyncButton = (service) => {
    if (!~['habitica'].indexOf(service)) {return null}
    if (as) {return null}
    if (!user.habitica_user_id) {return null}
    if (fetchingSvc) {return spinner}
    return <>
      <SimplePopover text='Gnothi auto-syncs every hour'>
        <Button size='sm' onClick={() => fetchService(service)}>Sync</Button>
      </SimplePopover>
    </>
  }

  const onFormClose = () => {
    setShowForm(false)
    dispatch(getFields())
  }

  const onChartClose = () => {
    setShowChart(false)
  }

  const renderFieldEntry = (f, fe) => {
    if (f.type === 'fivestar') return <>
      <ReactStars
        value={fe || 0}
        half={false}
        size={25}
        onChange={changeFieldVal(f.id, true)}
      />
    </>
    if (f.type === 'check') return <div>
      <Form.Check
        type='radio'
        label='Yes'
        id={f.id + '-yes'}
        inline
        checked={fe > 0}
        onChange={changeCheck(f.id)}
      />
      <Form.Check
        type='radio'
        label='No'
        id={f.id + '-no'}
        inline
        checked={fe < 1}
        onChange={changeCheck(f.id)}
      />
    </div>
    return <>
      <Form.Control
        disabled={!!f.service && isToday}
        type='number'
        size="sm"
        value={fe || 0}
        onChange={changeFieldVal(f.id)}
      />
    </>
  }

  const pickDupe = async (fe) => {
    await Promise.all(_.map(dupes[fe.field_id], async (d) => {
      if (fe.id === d.id) {return Promise.resolve()}
      await dispatch(fetch_(`field-entries/${d.id}`, 'delete'))
    }))
    await fetchFieldEntries()
  }

  const renderDupes = (f) => {
    return <Alert variant='warning' style={{margin: 0, padding: 0}}>
      <div><FaExclamationTriangle /> Duplicates <a href="https://github.com/lefnire/gnothi/issues/20" target="_blank">bug</a>! Pick the one that's correct.</div>
      {dupes[f.id].map((fe) => (
        <div key={fe.id} className='bottom-margin'>
          <Button variant='outline-dark' size='sm' onClick={() => pickDupe(fe)}>Pick</Button>{' '}
          {f.type === 'check' ? (fe.value === 1 ? 'Yes' : 'No')
              : fe.value
          }
        </div>
      ))}
    </Alert>
  }

  const renderField = (f) => {
    let rowStyle = {width: '100%', margin: 0}
    if (f.excluded_at) {
      rowStyle = {
        ...rowStyle,
        textDecoration: 'line-through',
        opacity: .5
      }
    }
    const c1 = {xs: 5}
    const c2 = {xs: 5}
    const c3 = {xs: 2}
    const colStyle = {style: {padding: 3}}
    const n_dupes = dupes[f.id] ? dupes[f.id].length : 0
    return (
      <Row
        key={`${f.id}-${n_dupes}`}
        style={rowStyle}
      >
        <Col
          {...c1}
          {...colStyle}
          onClick={() => setShowForm(f.id)}
          className='cursor-pointer'
        >
          <FieldName name={f.name}/>
        </Col>
        <Col {...c2} {...colStyle}>
          {n_dupes > 1
            ? renderDupes(f)
            : renderFieldEntry(f, fieldEntries[f.id])
          }
        </Col>
        <Col {...c3} {...colStyle}>
          <div
            onClick={() => setShowChart(f.id)}
            className='cursor-pointer'
          >
            <FaChartLine />{' '}
            {f.avg && f.avg.toFixed(1)}
          </div>
        </Col>
      </Row>
    )
  }

  // see 3b92a768 for dynamic field groups. Revisit when more than one service,
  // currently just habitica
  const groups = [{
    service: 'custom',
    name: 'Custom',
    fields: _(fields)
      .filter(v => !v.service && !v.excluded_at)
      .sortBy('id').value(),
    emptyText: () => <small className='text-muted'>
      <p>Fields are activity & quality trackers. Mood, sleep, substance, habits, etc. They can be numbers, checkboxes, or fivestar-ratings.<ul>
        <li>Track your mood, sleep patterns, substance intake, etc</li>
        <li>See stats (average, graphs, predictions)</li>
        <li>See how fields interact: correlation. Eg, "sleep most influenced by alcohol".</li>
        <li>Help long-term decisions by tracking options (fivestar-rate different jobs or moving destinations).</li>
        <li>Share fields, eg with a therapist who's interested in your mood or substances.</li>
        <li>For habits specifically, I recommend Habitica (below).</li>
      </ul></p>
    </small>
  }, {
    service: 'habitica',
    name: 'Habitica',
    fields: _(fields)
      .filter(v => v.service === 'habitica' && !v.excluded_at)
      .sortBy('id')
      .value(),
    emptyText: () => <small className='text-muted'>
      <p>For habit-tracking (exercise, substance, productivity, etc) I recommend <a href='https://habitica.com/' target='_blank'>Habitica</a>. Gnothi will sync Habitica habits & dailies.</p>
      <p>Use Gnothi fields for qualitative data (mood, sleep-quality, decisions) and Habitica for habits. Habitica doesn't support arbitrary number entries.</p>
      <p>Your UserID and API Token are database-encrypted. <em>All</em> sensitive data in Gnothi is encrypted.</p>
    </small>
  }, {
    service: 'excluded',
    name: 'Excluded',
    fields: _(fields)
      .filter(v => v.excluded_at)
      .sortBy('id')
      .value(),
    emptyText: () => <small className='text-muted'>
      <p>If you stop tracking a field, but keep it around just in case, click "Remove" and it will show up here.</p>
    </small>
  }]

  const renderButtons = g => {
    if (g.service === 'custom') {
      return <>
        {!as && <Button
          variant="success"
          size="sm"
          onClick={() => setShowForm(true)}
          className='bottom-margin'
        >New Field</Button>}
        {!!g.fields.length && <Button
          variant="outline-primary"
          style={{float:'right'}}
          size="sm"
          onClick={() => setShowChart(true)}
        >Top Influencers</Button>}
      </>
    }
    if (g.service === 'habitica' && !as) {
      return <SetupHabitica />
    }
    return null
  }

  const renderGroup = g => (
    <Card key={g.service}>
      <Accordion.Toggle as={Card.Header} eventKey={g.service}>
        {g.name}
      </Accordion.Toggle>
      <Accordion.Collapse eventKey={g.service}>
        <Card.Body>
          {g.fields.length ? g.fields.map(renderField) : g.emptyText()}
          {renderSyncButton(g.service)}
          {renderButtons(g)}
        </Card.Body>
      </Accordion.Collapse>
    </Card>
  )

  return <div className="sidebar-fields">
    {showForm && (
      <FieldModal
        close={onFormClose}
        field={showForm === true ? {} : fields[showForm]}
      />
    )}

    {showChart && (
      <ChartModal
        field={showChart === true ? null : fields[showChart]}
        overall={showChart === true}
        close={onChartClose}
      />
    )}

    <Accordion defaultActiveKey="custom">
      {groups.map(renderGroup)}
    </Accordion>

    <div className='day-changer'>
      <ButtonGroup aria-label="Edit days">
        <Button
          variant="outline-secondary"
          onClick={() => changeDay(-1)}
        >{"<"}</Button>
        <Button
          variant="outline-secondary"
          onClick={() => changeDay(1)}
          disabled={isToday}
        >{">"}</Button>
      </ButtonGroup>
    </div>
    <div className='selected-day'>{day}</div>
  </div>
}
