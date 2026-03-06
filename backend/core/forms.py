
from django import forms
from .models import Asset, Conference
from django.core.exceptions import ValidationError

class AssetForm(forms.ModelForm):
    class Meta:
        model = Asset
        fields = '__all__'
        widgets = {
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'brand': forms.TextInput(attrs={'class': 'form-control'}),
            'model_number': forms.TextInput(attrs={'class': 'form-control'}),
            'serial_number': forms.TextInput(attrs={'class': 'form-control'}),
            'sku': forms.TextInput(attrs={'class': 'form-control'}),
            'item_price': forms.NumberInput(attrs={'class': 'form-control'}),
            'barcode': forms.TextInput(attrs={'class': 'form-control'}),
            'status': forms.Select(attrs={'class': 'form-select'}),
        }

class ConferenceForm(forms.ModelForm):
    class Meta:
        model = Conference
        fields = '__all__'
        widgets = {
            'start_date': forms.DateInput(attrs={'type': 'date', 'class': 'form-control'}),
            'end_date': forms.DateInput(attrs={'type': 'date', 'class': 'form-control'}),
            'billing_address': forms.Textarea(attrs={'rows': 3, 'class': 'form-control'}),
        }

    def clean(self):
        cleaned_data = super().clean()
        start_date = cleaned_data.get("start_date")
        end_date = cleaned_data.get("end_date")

        if start_date and end_date and start_date > end_date:
            raise ValidationError("Start date cannot be after end date.")
        
        return cleaned_data
