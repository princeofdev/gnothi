import {
  Autocomplete, Checkbox, FormControl, FormControlLabel,
  FormHelperText, TextField, InputLabel, Select, MenuItem, FormGroup
} from "@material-ui/core";
import {Controller} from "react-hook-form";
import React from "react";


export function TextField2(props) {
  const {name, form, onChange, ...rest} = props

  function renderField({ field, fieldState: {error} }) {
    function change(e) {
      onChange?.(e)
      field.onChange(e)
    }
    return <TextField
      fullWidth
      value={field.value}
      onChange={change}
      error={!!error}
      helperText={error?.message}
      {...rest}
    />
  }

  return <Controller
    name={name}
    control={form.control}
    render={renderField}
  />
}

export function Checkbox2(props) {
  const {name, label, helperText, form, ...rest} = props

  function renderField({field}) {
    return <Checkbox
      checked={field.value}
      onChange={field.onChange}
      {...rest}
    />
  }

  return <FormControl>
    <FormControlLabel
      label={label}
      control={<Controller
        name={name}
        control={form.control}
        render={renderField}
      />}
    />
    {helperText && <FormHelperText>{helperText}</FormHelperText>}
  </FormControl>
}

export function Autocomplete2(props) {
  const {name, label, form, options, ...rest} = props

  return <Controller
    name={name}
    control={form.control}
    render={({field}) => <Autocomplete
        disablePortal
        value={field.value}
        onChange={(e, data) => field.onChange(data)}
        fullWidth
        options={options}
        renderInput={(params) => <TextField
          {...params}
          label={label}
        />}
        {...rest}
      />
    }
  />
}

export function Select2(props) {
  const {name, label, form, options, helperText, ...rest} = props

  function renderField({field}) {
    return <>
      <FormControl fullWidth>
        <InputLabel id={`${name}-select-label`}>{label}</InputLabel>
        <Select
          labelId={`${name}-select-label`}
          id={`${name}-select`}
          value={field.value}
          label={label}
          onChange={field.onChange}
        >
          {options.map(o => <MenuItem value={o.value}>{o.label}</MenuItem>)}
        </Select>
        {helperText && <FormHelperText>{helperText}</FormHelperText>}
      </FormControl>
    </>
  }

  return <Controller render={renderField} name={name} control={form.control}/>

}
